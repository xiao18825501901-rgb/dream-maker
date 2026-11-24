import unittest,tempfile,zipfile,stat,importlib.util
from pathlib import Path
s=importlib.util.spec_from_file_location('inspection',Path(__file__).resolve().parents[2]/'scripts/revamp/inspect-source-zip.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class ZipTests(unittest.TestCase):
 def archive(self,entries):
  tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup);p=Path(tmp.name)/'source.zip'
  with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
   for name,body in entries:
    if isinstance(name,str):
     raw=name;name=zipfile.ZipInfo(raw);name.filename=raw;name.orig_filename=raw;name.compress_type=zipfile.ZIP_DEFLATED
    z.writestr(name,body)
  return p
 def test_clean_readonly(self):
  p=self.archive([('repo/README.md','data'),('repo/LICENSE','synthetic')]);r=m.inspect_zip(p)
  self.assertEqual(r['entryCount'],2);self.assertFalse(r['extractedFiles']);self.assertFalse(r['licenseApproved']);self.assertFalse((p.parent/'repo').exists())
 def test_path_traversal(self):
  for name in ['../outside','/outside','C:/x','r/../../x','r\\x','r/x\x00hidden','r/%2e%2e/file','r/a:stream']:
   with self.subTest(name=name):
    with self.assertRaises(m.ArchiveRejected):m.inspect_zip(self.archive([(name,'data')]))
 def test_fixture_preserves_the_original_name(self):
  p=self.archive([('r\\x','data')])
  with zipfile.ZipFile(p) as z:self.assertEqual(z.infolist()[0].orig_filename,'r\\x')
 def test_symlink(self):
  i=zipfile.ZipInfo('r/link');i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16
  with self.assertRaisesRegex(m.ArchiveRejected,'LINK_OR_SPECIAL'):m.inspect_zip(self.archive([(i,'../../outside')]))
 def test_case_collision(self):
  with self.assertRaisesRegex(m.ArchiveRejected,'COLLISION'):m.inspect_zip(self.archive([('r/Main.ts','x'),('r/main.ts','y')]))
 def test_reserved(self):
  with self.assertRaisesRegex(m.ArchiveRejected,'WINDOWS_RESERVED'):m.inspect_zip(self.archive([('r/CON.txt','x')]))
 def test_control_metadata(self):
  for path in ['r/.git/config','r/.gitmodules']:
   with self.assertRaisesRegex(m.ArchiveRejected,'GIT_CONTROL'):m.inspect_zip(self.archive([(path,'data')]))
 def test_file_directory(self):
  with self.assertRaisesRegex(m.ArchiveRejected,'FILE_DIRECTORY'):m.inspect_zip(self.archive([('r/a/b','x'),('r/a','y')]))
 def test_expansion(self):
  with self.assertRaisesRegex(m.ArchiveRejected,'EXPANSION'):m.inspect_zip(self.archive([('r/bomb','0'*(2*1024*1024))]))
if __name__=='__main__':unittest.main()
