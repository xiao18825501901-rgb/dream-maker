"""Offline validation only. Real Linux process ownership is a separate local CLI check."""
import importlib.util
import pathlib
import unittest

SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'scripts/isolation/codex-owned-process.py'
spec = importlib.util.spec_from_file_location('owned_codex', SOURCE)
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)

class OwnedCodexValidation(unittest.TestCase):
    def test_proxy_environment_copies_only_an_exact_private_tuple(self):
        proxy = 'http://172.27.48.1:7890/'
        environment = {
            key: proxy for key in owned.PROXY_KEYS
        } | {
            'NO_PROXY': 'localhost,127.0.0.1,::1,[::1]',
            'no_proxy': 'localhost,127.0.0.1,::1,[::1]',
            'UNRELATED_SECRET': 'must-not-cross'
        }
        actual = owned.proxy_environment(environment)
        self.assertEqual(actual, {
            **{key: proxy for key in owned.PROXY_KEYS},
            'NO_PROXY': 'localhost,127.0.0.1,::1,[::1]',
            'no_proxy': 'localhost,127.0.0.1,::1,[::1]'
        })
        self.assertNotIn('UNRELATED_SECRET', actual)

    def test_proxy_environment_rejects_incomplete_or_invalid_routes(self):
        proxy = 'http://172.27.48.1:7890/'
        valid = {
            key: proxy for key in owned.PROXY_KEYS
        } | {
            'NO_PROXY': 'localhost,127.0.0.1,::1,[::1]',
            'no_proxy': 'localhost,127.0.0.1,::1,[::1]'
        }
        cases = []
        for mutate in [
            lambda value: value.pop('all_proxy'),
            lambda value: value.__setitem__('https_proxy', 'http://172.27.48.1:7891/'),
            lambda value: value.__setitem__('HTTP_PROXY', 'http://127.0.0.1:7890/'),
            lambda value: value.__setitem__('HTTP_PROXY', 'http://999.27.48.1:7890/'),
            lambda value: value.__setitem__('HTTP_PROXY', 'http://172.27.48.1:7890'),
            lambda value: value.__setitem__('NO_PROXY', '*')
        ]:
            changed = valid.copy()
            mutate(changed)
            cases.append(changed)
        for environment in cases:
            with self.subTest(environment=environment):
                with self.assertRaises(ValueError):
                    owned.proxy_environment(environment)

    def test_paths_stay_inside_dedicated_controller(self):
        self.assertEqual(owned.safe_path('/opt/dream-maker-controller/codex-home-p2'), '/opt/dream-maker-controller/codex-home-p2')
        for value in ['/tmp/home', '/opt/dream-maker-controller/../outside', '/opt/dream-maker-controller//home', 'C:/home', '/opt/dream-maker-controller/a b']:
            with self.assertRaises(ValueError): owned.safe_path(value)

    def test_marker_is_nonce_and_scope_bound(self):
        for value in ['../escape', 'owned_codex_BAD', 'foreign_123', 'owned_codex_' + 'a' * 21]:
            with self.assertRaises(ValueError): owned.marker_name(value)
        self.assertEqual(owned.marker_name('owned_codex_' + 'a' * 20), 'owned_codex_' + 'a' * 20 + '.json')

    def test_unknown_or_changed_marker_never_proves_cleanup(self):
        marker = {'schema':'dream-maker.owned-codex.v1','markerId':'owned_codex_'+'a'*20,'pid':12,'groupId':12,'sessionId':12,'startTicks':'200','bootId':'boot-old','pidNamespace':'pid:[old]'}
        self.assertFalse(owned.cleanup_proven(marker, expected_hash=None, actual_hash='b'*64, boot_id='boot-old', members=[])['proven'])
        self.assertFalse(owned.cleanup_proven(marker, expected_hash='c'*64, actual_hash='b'*64, boot_id='boot-old', members=[])['proven'])
        self.assertFalse(owned.cleanup_proven(marker, expected_hash='b'*64, actual_hash='b'*64, boot_id='boot-old', members=[12])['proven'])

    def test_pinned_group_absence_and_real_kernel_restart_are_distinct_proofs(self):
        marker = {'schema':'dream-maker.owned-codex.v1','markerId':'owned_codex_'+'a'*20,'pid':12,'groupId':12,'sessionId':12,'startTicks':'200','bootId':'boot-old','pidNamespace':'pid:[old]'}
        result=owned.cleanup_proven(marker,expected_hash='b'*64,actual_hash='b'*64,boot_id='boot-old',members=[],pid_namespace='pid:[old]')
        self.assertTrue(result['proven']);self.assertEqual(result['reason'],'SCOPED_PROCESS_GROUP_EMPTY')
        result=owned.cleanup_proven(marker,expected_hash='b'*64,actual_hash='b'*64,boot_id='boot-new',members=[])
        self.assertTrue(result['proven']);self.assertEqual(result['reason'],'PREVIOUS_KERNEL_ENDED')
        result=owned.cleanup_proven(marker,expected_hash='b'*64,actual_hash='b'*64,boot_id='boot-old',members=[],pid_namespace='pid:[new]')
        self.assertFalse(result['proven']);self.assertEqual(result['reason'],'PROCESS_NAMESPACE_UNVERIFIED_OR_CHANGED')

if __name__ == '__main__': unittest.main()
