"""OFFLINE archive/URL tests; never downloads, installs or runs Codex."""
import importlib.util
import io
import pathlib
import tarfile
import unittest
spec=importlib.util.spec_from_file_location('installer',pathlib.Path(__file__).parents[1]/'scripts/isolation/install-codex-wsl.py')
installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)

class InstallBoundaries(unittest.TestCase):
    def archive(self,name,kind=tarfile.REGTYPE):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w') as archive:
            member=tarfile.TarInfo(name);member.type=kind;member.size=0;archive.addfile(member)
        stream.seek(0)
        return tarfile.open(fileobj=stream,mode='r')

    def test_plain_package_member(self):
        with self.archive('package/bin/codex.js') as archive:
            self.assertEqual(len(installer.checked_members(archive)),1)

    def test_traversal_absolute_foreign_root_and_windows_paths(self):
        for name in ['package/../../escape','/absolute','foreign/data','package/C:/escape','package\\escape']:
            with self.subTest(name=name),self.archive(name) as archive:
                with self.assertRaises(RuntimeError):installer.checked_members(archive)

    def test_symlink_hardlink_devices_and_fifo(self):
        for kind in [tarfile.SYMTYPE,tarfile.LNKTYPE,tarfile.CHRTYPE,tarfile.FIFOTYPE]:
            with self.subTest(kind=kind),self.archive('package/link',kind) as archive:
                with self.assertRaises(RuntimeError):installer.checked_members(archive)

    def test_registry_only_https_no_query_userinfo_port_or_foreign_paths(self):
        self.assertEqual(installer.registry_url('https://registry.npmjs.org/@openai%2Fcodex/0.162.0'),'https://registry.npmjs.org/@openai%2Fcodex/0.162.0')
        for url in ['http://registry.npmjs.org/@openai/codex','https://evil.example/@openai/codex','https://user@registry.npmjs.org/@openai/codex','https://registry.npmjs.org:444/@openai/codex','https://registry.npmjs.org/@openai/codex?x=1','https://registry.npmjs.org/arbitrary']:
            with self.subTest(url=url),self.assertRaises(RuntimeError):installer.registry_url(url)

if __name__=='__main__':unittest.main()
