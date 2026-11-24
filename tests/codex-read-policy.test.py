"""OFFLINE TOML checks; no CLI, model, credential or network invocation."""
import pathlib
import tomllib
import unittest

class ReadPolicy(unittest.TestCase):
    def test_only_scoped_read_and_no_network(self):
        root=pathlib.Path(__file__).parents[1]
        config=tomllib.loads((root/'config/codex-agent-readonly.toml').read_text())
        name=config['default_permissions'];self.assertEqual(set(config['permissions']),{name})
        profile=config['permissions'][name];self.assertEqual(profile['extends'],':read-only')
        fs=profile['filesystem'];self.assertEqual(fs[':root'],'deny');self.assertEqual(fs[':minimal'],'read')
        self.assertEqual(fs[':workspace_roots'],{'.':'read'})
        self.assertEqual(fs[':tmpdir'],'deny');self.assertEqual(fs[':slash_tmp'],'deny')
        binary='/opt/dream-maker-controller/codex-0.162.0/launcher/package/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
        self.assertEqual(fs[binary],'read')
        self.assertEqual(set(fs),{':root',':minimal',':workspace_roots',':tmpdir',':slash_tmp',binary})
        self.assertEqual(profile['network'],{'enabled':False})
        self.assertNotIn('workspace_roots',profile)

if __name__=='__main__':unittest.main()
