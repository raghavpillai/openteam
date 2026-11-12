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

    def test_multiple_items_require_selection_before_network(self):
        code,out=self.run_cli(lambda *a: self.fail('network must not run'), ['recurring'])
        self.assertEqual(code,2); self.assertEqual(out['error']['code'],'CONFIG_ERROR')

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

if __name__=='__main__':unittest.main()
