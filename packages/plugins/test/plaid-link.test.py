import contextlib
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
source = Path(__file__).parents[1] / 'plaid/skills/plaid-setup/scripts/plaid-link.py'
spec = importlib.util.spec_from_file_location('plaid_link', source)
link = importlib.util.module_from_spec(spec)
spec.loader.exec_module(link)


class HostedLinkTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.path = Path(self.root.name) / 'plaid-cli/config.json'
        self.config = {'client_id':'client-example', 'env':'production', 'other':'keep',
                       'environments':{'sandbox':{'secret':'sandbox-example'}, 'production':{
                       'secret':'secret-example', 'items':[{'item_id':'existing', 'access_token':'existing-token',
                       'alias':'keep-me', 'sync_cursor':'keep-cursor', 'institution_id':'ins_existing'}]}}}
        link.save_json(self.path, self.config)
        self.requests = []
        self.poll = {'link_sessions':[]}
        self.exchange_error = None
        self.account_error = None
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {}, clear=True).start()
        patch.object(link.api, 'config_path', return_value=self.path).start()
        patch.object(link.api, 'request_raw', side_effect=self.transport).start()

    def transport(self, env, endpoint, client, secret, payload):
        self.assertEqual((env, client, secret), ('production','client-example','secret-example'))
        self.requests.append((endpoint, payload))
        if endpoint == '/link/token/create':
            return {'link_token':'link-example', 'hosted_link_url':'https://secure.plaid.com/hl/example',
                    'expiration':(datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()}
        if endpoint == '/link/token/get':
            self.assertEqual(payload, {'link_token':'link-example'})
            return self.poll
        if endpoint == '/item/public_token/exchange':
            if self.exchange_error:
                return {'error':self.exchange_error}
            suffix = payload['public_token'].split('-')[-1]
            return {'item_id':'new-'+suffix, 'access_token':'access-'+suffix}
        if endpoint == '/accounts/get':
            if self.account_error:
                return {'error':self.account_error}
            suffix = payload['access_token'].split('-')[-1]
            return {'item':{'item_id':'new-'+suffix}, 'accounts':[{
                    'account_id':'account-'+suffix, 'name':'Checking', 'mask':'1234', 'type':'depository', 'subtype':'checking'}]}
        self.fail('Unexpected endpoint '+endpoint)

    def run_cli(self, args):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = link.main(args)
        result = json.loads(out.getvalue())
        for value in ('secret-example', 'existing-token', 'access-first', 'public-first', 'link-example'):
            self.assertNotIn(value, out.getvalue())
        return code, result

    def start(self):
        code, result = self.run_cli(['create'])
        self.assertEqual(code, 0)
        self.sid = result['session_id']
        self.state_path = link.session_path(self.path, self.sid)
        return result

    def ready(self, tokens=('public-first',)):
        self.poll = {'link_sessions':[{'started_at':'2026-01-01T00:00:00Z', 'finished_at':'2026-01-01T00:01:00Z',
                     'results':{'item_add_results':[{'public_token':t, 'institution':{'institution_id':'ins_new'}} for t in tokens]}}]}

    def count(self, endpoint):
        return sum(e == endpoint for e, _ in self.requests)

    def test_create_hosted_url_preserves_config_and_omits_delivery(self):
        before = self.path.read_bytes()
        result = self.start()
        payload = self.requests[0][1]
        self.assertEqual(payload['hosted_link'], {'url_lifetime_seconds':3600})
        self.assertEqual(payload['products'], ['transactions'])
        self.assertEqual(payload['transactions'], {'days_requested':180})
        self.assertNotIn('webhook', payload)
        self.assertNotIn('delivery_method', payload['hosted_link'])
        self.assertEqual(result['url'], 'https://secure.plaid.com/hl/example')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.state_path.stat().st_mode & 0o777, 0o600)

    def test_pending_complete_creates_no_item(self):
        self.start(); before = self.path.read_bytes()
        code, result = self.run_cli(['complete', '--session', self.sid])
        self.assertEqual((code, result['status']), (0, 'pending'))
        self.assertEqual(self.count('/item/public_token/exchange'), 0)
        self.assertEqual(self.path.read_bytes(), before)

    def test_user_identity_persists_between_link_sessions(self):
        self.start(); self.start()
        users=[p['user']['client_user_id'] for e,p in self.requests if e=='/link/token/create']
        self.assertEqual(users[0],users[1])

    def test_environment_override_cannot_replace_client_of_existing_items(self):
        with patch.dict(os.environ,{'PLAID_CLIENT_ID':'different-client'}):
            code,result=self.run_cli(['create'])
        self.assertEqual((code,result['error']['code']),(1,'PROFILE_CHANGED'))
        self.assertEqual(self.requests,[])

    def test_multiple_results_deduplicate_and_repeat_without_exchange(self):
        self.start(); self.ready(('public-first', 'public-second', 'public-first'))
        code, result = self.run_cli(['complete', '--session', self.sid])
        self.assertEqual((code, result['status']), (0, 'connected'))
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(self.count('/item/public_token/exchange'), 2)
        config = link.read_json(self.path)
        self.assertEqual(config['environments']['production']['items'][0], self.config['environments']['production']['items'][0])
        self.assertEqual(config['environments']['sandbox'], self.config['environments']['sandbox'])
        self.assertEqual(config['other'], 'keep')
        self.assertEqual(len(config['environments']['production']['items']), 3)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.run_cli(['complete', '--session', self.sid])
        self.assertEqual(self.count('/item/public_token/exchange'), 2)
        self.assertEqual(self.count('/accounts/get'), 4)

    def test_legacy_on_success_is_supported(self):
        self.start()
        self.poll = {'link_sessions':[{'on_success':{'public_token':'public-first', 'metadata':{'institution':None}}}]}
        code, result = self.run_cli(['complete', '--session', self.sid])
        self.assertEqual((code, result['status']), (0, 'connected'))
        self.assertIsNone(result['items'][0]['institution_id'])

    def test_exit_retry_and_expiration_do_not_claim_success(self):
        self.start()
        self.poll = {'link_sessions':[{'started_at':'2026-01-01T00:00:00Z', 'finished_at':'2026-01-01T00:01:00Z'}]}
        self.assertEqual(self.run_cli(['status','--session',self.sid])[1]['status'], 'exited')
        self.poll['link_sessions'].append({'started_at':'2026-01-02T00:00:00Z'})
        self.assertEqual(self.run_cli(['status','--session',self.sid])[1]['status'], 'pending')
        state = link.read_json(self.state_path); state['expiration']='2020-01-01T00:00:00Z'; link.save_json(self.state_path,state)
        self.poll = {'link_sessions':[]}
        self.assertEqual(self.run_cli(['status','--session',self.sid])[1]['status'], 'expired')

    def test_removed_item_is_not_restored_by_repeat_complete(self):
        self.start(); self.ready(); self.run_cli(['complete','--session',self.sid])
        link.save_json(self.path, self.config); before = self.path.read_bytes()
        code, result = self.run_cli(['complete','--session',self.sid])
        self.assertEqual((code,result['error']['code']), (1,'ITEM_NOT_SAVED'))
        self.assertEqual(self.path.read_bytes(), before)

    def test_wrong_profile_rejected_before_poll(self):
        self.start()
        with patch.dict(os.environ, {'PLAID_ENV':'sandbox'}):
            code, result = self.run_cli(['status','--session',self.sid])
        self.assertEqual((code,result['error']['code']), (1,'PROFILE_CHANGED'))
        self.assertEqual(self.count('/link/token/get'),0)

    def test_invalid_session_does_not_read_arbitrary_path(self):
        code, result = self.run_cli(['status','--session','../../config'])
        self.assertEqual(code,2); self.assertEqual(result['error']['code'],'LOCAL_STATE_ERROR')
        self.assertEqual(self.requests,[])

    def test_uncertain_exchange_is_not_retried(self):
        for failure in ({'code':'NETWORK_ERROR'}, {'code':'HTTP_ERROR','http_status':500}):
            self.start(); self.ready(); self.exchange_error = failure
            self.assertEqual(self.run_cli(['complete','--session',self.sid])[0],1)
            count = self.count('/item/public_token/exchange')
            self.exchange_error = None
            code,result = self.run_cli(['complete','--session',self.sid])
            self.assertEqual((code,result['error']['code']),(1,'EXCHANGE_UNCERTAIN'))
            self.assertEqual(self.count('/item/public_token/exchange'),count)

    def test_config_write_failure_recovers_saved_exchange_without_reexchange(self):
        self.start(); self.ready()
        with patch.object(link,'merge_item',side_effect=OSError('disk full')):
            self.assertEqual(self.run_cli(['complete','--session',self.sid])[0],2)
        code,result = self.run_cli(['complete','--session',self.sid])
        self.assertEqual((code,result['status']),(0,'connected'))
        self.assertEqual(self.count('/item/public_token/exchange'),1)

    def test_verification_failure_is_preserved_and_retry_does_not_reexchange(self):
        self.start(); self.ready(); self.account_error={'code':'ITEM_LOGIN_REQUIRED','message':'access-first secret-example'}
        code,result=self.run_cli(['complete','--session',self.sid])
        self.assertEqual((code,result['error']['code']),(1,'ITEM_LOGIN_REQUIRED'))
        self.account_error=None
        self.assertEqual(self.run_cli(['complete','--session',self.sid])[1]['status'],'connected')
        self.assertEqual(self.count('/item/public_token/exchange'),1)

    def test_existing_item_token_conflict_is_not_overwritten(self):
        self.config['environments']['production']['items'].append({'item_id':'new-first','access_token':'different-token'})
        link.save_json(self.path,self.config); before=self.path.read_bytes()
        self.start(); self.ready()
        code,result=self.run_cli(['complete','--session',self.sid])
        self.assertEqual((code,result['error']['code']),(1,'ITEM_CONFLICT'))
        self.assertEqual(self.path.read_bytes(),before)

    def test_changed_config_aborts_save(self):
        before=self.path.read_bytes()
        with patch.object(link.Path,'read_bytes',side_effect=[before,before+b' ']):
            with self.assertRaises(link.LinkError) as error:
                link.merge_item(self.path,'production','client-example','secret-example',{'item_id':'new','access_token':'new-token'})
        self.assertEqual(error.exception.data['code'],'CONFIG_CHANGED')
        self.assertEqual(self.path.read_bytes(),before)

    def test_environment_only_credentials_can_create_and_save_new_config(self):
        self.path.unlink()
        with patch.dict(os.environ,{'PLAID_ENV':'production','PLAID_CLIENT_ID':'client-example','PLAID_SECRET':'secret-example'}):
            self.start(); self.ready(); code,result=self.run_cli(['complete','--session',self.sid])
        self.assertEqual((code,result['status']),(0,'connected'))
        self.assertEqual(link.read_json(self.path)['environments']['production']['items'][0]['item_id'],'new-first')


if __name__ == '__main__':
    unittest.main()
