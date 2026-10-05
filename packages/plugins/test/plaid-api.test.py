import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import sys
sys.dont_write_bytecode = True
import unittest
from unittest.mock import patch
import urllib.error

source = Path(__file__).parents[1] / 'plaid/skills/plaid-setup/scripts/plaid-api.py'
spec = importlib.util.spec_from_file_location('plaid_api', source)
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

class ApiTests(unittest.TestCase):
    def config(self):
        return {'client_id':'client-example', 'env':'production', 'environments':{'production':{'secret':'secret-example', 'items':[{'item_id':'first','access_token':'token-first','institution_id':'bank-one'}, {'item_id':'second','access_token':'token-second','institution_id':'bank-two','alias':'other'}]}}}

    def run_cli(self, response, args):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root)/'config.json'; p.write_text(json.dumps(self.config())); before=p.read_bytes()
            with patch.dict(os.environ, {}, clear=True), patch.object(api,'config_path',return_value=p), patch.object(api,'query',side_effect=response), contextlib.redirect_stdout(io.StringIO()) as output:
                code=api.main(args)
            self.assertEqual(p.read_bytes(),before)
            return code,json.loads(output.getvalue())

    def test_native_config_paths_match_cli(self):
        with patch.dict(os.environ, {'XDG_CONFIG_HOME':'/tmp/test-config'}, clear=True), patch.object(api.sys,'platform','darwin'), patch.object(api.Path,'home',return_value=Path('/home/example')):
            self.assertEqual(api.config_path(),Path('/home/example/Library/Application Support/plaid-cli/config.json'))
        with patch.dict(os.environ, {'XDG_CONFIG_HOME':'/tmp/test-config'}, clear=True), patch.object(api.sys,'platform','linux'):
            self.assertEqual(api.config_path(),Path('/tmp/test-config/plaid-cli/config.json'))

    def test_multiple_items_require_selection_before_network(self):
        code,out=self.run_cli(lambda *a: self.fail('network must not run'), ['recurring'])
        self.assertEqual(code,2); self.assertEqual(out['error']['code'],'CONFIG_ERROR')

    def test_all_preserves_partial_failure_and_exits_nonzero(self):
        def result(*args):
            return {'outflow_streams':[]} if args[4]['item_id']=='first' else {'error':{'code':'ADDITIONAL_CONSENT_REQUIRED'}}
        code,out=self.run_cli(result,['holdings','--all'])
        self.assertEqual(code,1)
        self.assertEqual([i['item_id'] for i in out['items']],['first','second'])
        self.assertEqual(out['items'][1]['data']['error']['code'],'ADDITIONAL_CONSENT_REQUIRED')

    def test_alias_selects_exact_item(self):
        def result(*args):
            self.assertEqual(args[4]['item_id'],'second'); return {'outflow_streams':[]}
        code,out=self.run_cli(result,['recurring','--item','other'])
        self.assertEqual(code,0); self.assertEqual(out,{'outflow_streams':[]})

    def test_invalid_environment_and_access_override_are_rejected(self):
        args=type('Args',(),{'item':'first','all':False})()
        with patch.dict(os.environ,{'PLAID_ENV':'http://example.com'},clear=True):
            with self.assertRaises(ValueError):api.select(self.config(),args)
        with patch.dict(os.environ,{'PLAID_ACCESS_TOKEN':'other-token'},clear=True):
            with self.assertRaises(ValueError):api.select(self.config(),args)

    def test_environment_credentials_override_config(self):
        args=type('Args',(),{'item':'first','all':False})()
        with patch.dict(os.environ,{'PLAID_CLIENT_ID':'override-client','PLAID_SECRET':'override-secret'},clear=True):
            env,client,secret,items=api.select(self.config(),args)
        self.assertEqual((env,client,secret),('production','override-client','override-secret'))
        self.assertEqual(items[0]['item_id'],'first')

    def test_http_error_surfaces_consent_and_redacts_auth_values(self):
        data={'error_code':'ADDITIONAL_CONSENT_REQUIRED','error_type':'ITEM_ERROR','error_message':'bad secret-example token-first','request_id':'req'}
        error=urllib.error.HTTPError('https://production.plaid.com',400,'bad',{},io.BytesIO(json.dumps(data).encode()))
        with patch.object(api.urllib.request,'urlopen',side_effect=error) as transport:
            out=api.query('production','holdings','client-example','secret-example',{'access_token':'token-first'}, {})
        self.assertEqual(out['error']['code'],'ADDITIONAL_CONSENT_REQUIRED')
        self.assertNotIn('secret-example',json.dumps(out)); self.assertNotIn('token-first',json.dumps(out))
        self.assertEqual(transport.call_count,1)

    def test_real_endpoint_and_payload_and_no_token_in_output(self):
        def response(request,timeout):
            self.assertEqual(request.full_url,'https://production.plaid.com/transactions/recurring/get')
            self.assertEqual(json.loads(request.data)['access_token'],'token-first')
            self.assertEqual(timeout,45)
            return io.BytesIO(json.dumps({'outflow_streams':[{'description':'Rent'}],'access_token':'token-first'}).encode())
        with patch.object(api.urllib.request,'urlopen',side_effect=response):
            out=api.query('production','recurring','client-example','secret-example',{'access_token':'token-first'}, {})
        self.assertEqual(out,{'outflow_streams':[{'description':'Rent'}]})

    def test_network_and_malformed_response_do_not_retry(self):
        for response in [urllib.error.URLError('failed'), ValueError('bad JSON')]:
            with patch.object(api.urllib.request,'urlopen',side_effect=response) as transport:
                out=api.query('production','recurring','c','s',{'access_token':'t'}, {})
                self.assertIn(out['error']['code'],['NETWORK_ERROR','INVALID_API_RESPONSE'])
                self.assertEqual(transport.call_count,1)

    def test_invalid_config_shape_is_rejected(self):
        args=type('Args',(),{'item':None,'all':False})()
        with patch.dict(os.environ,{},clear=True):
            for config in [[],{'environments':[]},{'environments':{'sandbox':[]}}, {'client_id':'c','environments':{'sandbox':{'secret':'s','items':[None]}}}]:
                with self.assertRaises(ValueError):api.select(config,args)

if __name__=='__main__':unittest.main()
