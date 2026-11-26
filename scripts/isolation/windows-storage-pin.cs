// Controller-owned Win32 directory custody. This library grants no execution or data parsing.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace DreamMaker {
    public sealed class StorageDirectoryPin : IDisposable {
        [StructLayout(LayoutKind.Sequential)]
        private struct FileInformation {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created;
            public System.Runtime.InteropServices.ComTypes.FILETIME Accessed;
            public System.Runtime.InteropServices.ComTypes.FILETIME Written;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern SafeFileHandle CreateFileW(string name, uint access, uint share,
            IntPtr security, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool CreateDirectoryW(string path, IntPtr security);

        private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
        private bool disposed;
        private FileStream imageStream;
        private static readonly char Separator = (char)92;
        private static readonly string Prefix = new string((char)92, 2) + "?" + (char)92;
        public string Identity { get; private set; }
        public string ImageHash { get; private set; }
        public long ImageBytes { get; private set; }
        public int Count { get { return handles.Count; } }
        private StorageDirectoryPin() { }

        // The approved roots used to be the literal "F:\DreamMakerSuite" with the drive letter
        // spelled out twice, so a correctly configured installation on any other volume failed
        // with STORAGE_PIN_SCOPE_DENIED before a single byte was touched. The boundary is still
        // "these exact roots and nothing else"; it is just no longer welded to one letter.
        private static readonly string[] ApprovedScopes = LoadScopes();
        private static string[] LoadScopes() {
            string configured = Environment.GetEnvironmentVariable("DM_STORAGE_CUSTODY_SCOPES");
            if (String.IsNullOrEmpty(configured)) return new string[] { "F:" + Separator + "DreamMakerSuite" };
            List<string> scopes = new List<string>();
            foreach (string raw in configured.Split(';')) {
                string item = raw.Trim();
                if (item.Length < 3 || item[1] != ':' || item[2] != Separator) continue;
                scopes.Add(Path.GetFullPath(item.Replace('/', Separator)).TrimEnd(Separator));
            }
            if (scopes.Count == 0) throw new InvalidOperationException("STORAGE_PIN_SCOPE_DENIED");
            return scopes.ToArray();
        }
        private static string Validate(string input) {
            if (String.IsNullOrEmpty(input) || input.Length > 2048 || input.IndexOf((char)0) >= 0)
                throw new InvalidOperationException("STORAGE_PIN_PATH_DENIED");
            string value = input.Replace('/', Separator);
            if (value.Length < 4 || value[1] != ':' || value[2] != Separator)
                throw new InvalidOperationException("STORAGE_PIN_SCOPE_DENIED");
            string[] segments = value.Substring(3).Split(Separator);
            if (segments.Length > 64) throw new InvalidOperationException("STORAGE_PIN_PATH_DENIED");
            foreach (string segment in segments) {
                if (segment.Length == 0 || segment == "." || segment == ".." || segment.EndsWith(".") || segment.EndsWith(" "))
                    throw new InvalidOperationException("STORAGE_PIN_PATH_DENIED");
                foreach (char c in segment)
                    if (Char.IsControl(c) || Array.IndexOf(Path.GetInvalidFileNameChars(), c) >= 0)
                        throw new InvalidOperationException("STORAGE_PIN_PATH_DENIED");
            }
            string full = Path.GetFullPath(value);
            bool allowed = false;
            foreach (string scope in ApprovedScopes) {
                if (String.Equals(full, scope, StringComparison.OrdinalIgnoreCase) ||
                    full.StartsWith(scope + Separator, StringComparison.OrdinalIgnoreCase)) { allowed = true; break; }
            }
            if (!allowed) throw new InvalidOperationException("STORAGE_PIN_SCOPE_DENIED");
            return full;
        }

        private void OpenDirectory(string path) {
            // GENERIC_READ includes directory data access: metadata-only opens can
            // fail to participate in the deletion/rename sharing check on Windows.
            // READ|WRITE sharing is permitted, explicitly no DELETE sharing.
            // OPEN_REPARSE_POINT prevents following a replaced link before its type is checked.
            SafeFileHandle handle = CreateFileW(Prefix + path, 0x80000000, 3, IntPtr.Zero, 3,
                0x02000000 | 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                throw new Win32Exception(error, "STORAGE_PIN_OPEN_FAILED");
            }
            handles.Add(handle);
            FileInformation info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "STORAGE_PIN_IDENTITY_FAILED");
            if ((info.Attributes & 0x10) == 0 || (info.Attributes & 0x400) != 0)
                throw new InvalidOperationException("STORAGE_PIN_REPARSE_OR_NON_DIRECTORY");
            StringBuilder final = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
            if (length == 0 || length >= final.Capacity ||
                !String.Equals(final.ToString().TrimEnd(Separator), (Prefix + path).TrimEnd(Separator), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("STORAGE_PIN_FINAL_PATH_CHANGED");
            ulong index = ((ulong)info.IndexHigh << 32) | info.IndexLow;
            Identity = info.Volume.ToString("x") + ":" + index.ToString("x");
        }

        public static StorageDirectoryPin Acquire(string path) {
            return AcquireDirectories(path, false);
        }
        public static StorageDirectoryPin AcquireOrCreate(string path) {
            return AcquireDirectories(path, true);
        }
        private static StorageDirectoryPin AcquireDirectories(string path, bool create) {
            string full = Validate(path), volume = Path.GetPathRoot(full);
            StorageDirectoryPin pin = new StorageDirectoryPin();
            try {
                pin.OpenDirectory(volume);
                string current = volume;
                foreach (string segment in full.Substring(volume.Length).Split(Separator)) {
                    current = Path.Combine(current, segment);
                    // The suite root must already exist. Every deeper creation is
                    // one native step under a parent whose handle is still held.
                    // Do not replace this with recursive Directory.CreateDirectory.
                    if (create && !String.Equals(current, "F:" + Separator + "DreamMakerSuite", StringComparison.OrdinalIgnoreCase)) {
                        if (!CreateDirectoryW(Prefix + current, IntPtr.Zero)) {
                            int error = Marshal.GetLastWin32Error();
                            if (error != 183) throw new Win32Exception(error, "STORAGE_PIN_CREATE_FAILED");
                        }
                    }
                    pin.OpenDirectory(current);
                }
                return pin;
            } catch { pin.Dispose(); throw; }
        }
        public static StorageDirectoryPin AcquireImage(string directory, string operation, long expectedBytes, string expectedHash) {
            if (operation == null || operation.Length != 64 || !Regex.IsMatch(operation, "^[a-f0-9]{64}$") ||
                expectedHash == null || expectedHash.Length != 64 || !Regex.IsMatch(expectedHash, "^[a-f0-9]{64}$") ||
                expectedBytes < 512 || expectedBytes > 67108864 || expectedBytes % 512 != 0)
                throw new InvalidOperationException("STORAGE_IMAGE_BINDING_DENIED");
            // Each image owns its ancestor pins as well: disposing another directory
            // lease must not release this file's path protection.
            StorageDirectoryPin pin = Acquire(directory);
            try {
                string path = Path.Combine(Validate(directory), operation + ".sqlite");
                pin.OpenFile(path, expectedBytes, expectedHash, "STORAGE_IMAGE");
                return pin;
            } catch { pin.Dispose(); throw; }
        }
        public static StorageDirectoryPin AcquireFile(string path, long expectedBytes, string expectedHash) {
            if (expectedHash == null || expectedHash.Length != 64 || !Regex.IsMatch(expectedHash, "^[a-f0-9]{64}$") ||
                expectedBytes < 1 || expectedBytes > 67108864)
                throw new InvalidOperationException("STORAGE_FILE_BINDING_DENIED");
            string full = Validate(path), parent = Path.GetDirectoryName(full);
            StorageDirectoryPin pin = Acquire(parent);
            try {
                pin.OpenFile(full, expectedBytes, expectedHash, "STORAGE_FILE");
                return pin;
            } catch { pin.Dispose(); throw; }
        }
        private void OpenFile(string path, long expectedBytes, string expectedHash, string prefix) {
            SafeFileHandle handle = CreateFileW(Prefix + path, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                throw new Win32Exception(error, prefix + "_OPEN_FAILED");
            }
            handles.Add(handle);
            FileInformation info;
            if (!GetFileInformationByHandle(handle, out info))
                throw new Win32Exception(Marshal.GetLastWin32Error(), prefix + "_IDENTITY_FAILED");
            ulong length = ((ulong)info.SizeHigh << 32) | info.SizeLow;
            if ((info.Attributes & (0x10 | 0x400)) != 0 || info.Links != 1 || length != (ulong)expectedBytes)
                throw new InvalidOperationException(prefix + "_TYPE_OR_SIZE_CHANGED");
            StringBuilder final = new StringBuilder(32768);
            uint count = GetFinalPathNameByHandleW(handle, final, (uint)final.Capacity, 0);
            if (count == 0 || count >= final.Capacity || !String.Equals(final.ToString(), Prefix + path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException(prefix + "_FINAL_PATH_CHANGED");
            imageStream = new FileStream(handle, FileAccess.Read, 65536, false);
            using (SHA256 digest = SHA256.Create())
                ImageHash = BitConverter.ToString(digest.ComputeHash(imageStream)).Replace("-", "").ToLowerInvariant();
            if (!String.Equals(ImageHash, expectedHash, StringComparison.Ordinal))
                throw new InvalidOperationException(prefix + "_HASH_CHANGED");
            ImageBytes = expectedBytes;
            imageStream.Position = 0;
        }
        public void Dispose() {
            if (disposed) return;
            disposed = true;
            try { if (imageStream != null) imageStream.Dispose(); }
            finally {
                for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose();
                handles.Clear();
            }
        }
    }
}
