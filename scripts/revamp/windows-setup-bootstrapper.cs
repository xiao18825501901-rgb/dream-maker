using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

internal sealed class SetupFailure : Exception
{
    internal readonly string Code;
    internal SetupFailure(string code, string message) : base(message)
    {
        Code = code;
    }
}

internal sealed class ProcessResult
{
    internal int ExitCode;
    internal string Output;
    internal string Error;
}

internal static class DreamMakerSetup
{
    private const string MarkerText = "DREAMMAKER_SETUP";
    private const int MarkerBytes = 16;
    private const int HashBytes = 32;
    private const int LengthBytes = 8;
    private const int TrailerBytes = MarkerBytes + HashBytes + LengthBytes;
    private const long MaxPayloadBytes = 4L * 1024L * 1024L * 1024L;
    private const long MaxExtractedBytes = 1536L * 1024L * 1024L;
    private const long MaxEntryBytes = 512L * 1024L * 1024L;
    private const int MaxEntries = 20000;

    private static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            return Run(args);
        }
        catch (SetupFailure failure)
        {
            Console.Error.WriteLine(failure.Code + ": " + failure.Message);
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("SETUP_INTERNAL_ERROR: " + error.GetType().Name + ": " + error.Message);
            return 3;
        }
    }

    private static int Run(string[] args)
    {
        bool verifyOnly = false;
        bool? shortcuts = null;
        string target = null;
        for (int i = 0; i < args.Length; i++)
        {
            string argument = args[i];
            if (argument == "--help" || argument == "-h")
            {
                PrintHelp();
                return 0;
            }
            if (argument == "--verify-only")
            {
                if (verifyOnly)
                    throw new SetupFailure("SETUP_ARGUMENT_DUPLICATE", "--verify-only");
                verifyOnly = true;
                continue;
            }
            if (argument == "--shortcuts")
            {
                if (shortcuts.HasValue)
                    throw new SetupFailure("SETUP_SHORTCUT_ARGUMENT_CONFLICT", "Choose --shortcuts or --no-shortcuts once.");
                shortcuts = true;
                continue;
            }
            if (argument == "--no-shortcuts")
            {
                if (shortcuts.HasValue)
                    throw new SetupFailure("SETUP_SHORTCUT_ARGUMENT_CONFLICT", "Choose --shortcuts or --no-shortcuts once.");
                shortcuts = false;
                continue;
            }
            if (argument == "--install")
                continue;
            if (argument == "--target")
            {
                if (target != null)
                    throw new SetupFailure("SETUP_ARGUMENT_DUPLICATE", "--target");
                if (i + 1 >= args.Length)
                    throw new SetupFailure("SETUP_TARGET_MISSING", "--target requires an absolute directory.");
                target = args[++i];
                continue;
            }
            throw new SetupFailure("SETUP_ARGUMENT_UNKNOWN", argument);
        }

        if (verifyOnly && target != null)
            throw new SetupFailure("SETUP_ARGUMENT_CONFLICT", "--verify-only cannot be combined with --target.");
        if (verifyOnly && shortcuts.HasValue)
            throw new SetupFailure("SETUP_ARGUMENT_CONFLICT", "--verify-only cannot change shortcut settings.");
        if (target == null)
            target = DefaultInstallTarget();
        target = ValidateTarget(target);
        if (shortcuts == null)
            shortcuts = true;

        string executable = Assembly.GetExecutingAssembly().Location;
        byte[] digest;
        long payloadOffset;
        long payloadLength = ReadTrailer(executable, out digest, out payloadOffset);
        VerifyPayload(executable, payloadOffset, payloadLength, digest);

        string extractionRoot = CreateExtractionRoot(digest);
        bool completed = false;
        try
        {
            ExtractPayload(executable, payloadOffset, payloadLength, extractionRoot);
            bool suite;
            string packageRoot = FindPackageRoot(extractionRoot, out suite);
            RunPackageVerifier(packageRoot, suite);
            if (verifyOnly)
            {
                completed = true;
                Console.WriteLine(ResultJson(
                    "PASS_SETUP_PAYLOAD_VERIFIED",
                    false,
                    target,
                    shortcuts.Value,
                    digest,
                    packageRoot,
                    extractionRoot,
                    suite));
                return 0;
            }

            PrepareTargetParent(target);
            RunInstaller(packageRoot, target, shortcuts.Value);
            // Exit code zero alone does not prove that the child published an installation.
            RunPackageVerifier(target, suite);
            string installedManifest = suite ? "SUITE_COMPOSITION_MANIFEST.json" : "RELEASE_MANIFEST.json";
            if (!ConstantTimeEqual(File.ReadAllBytes(Path.Combine(packageRoot, installedManifest)),
                                   File.ReadAllBytes(Path.Combine(target, installedManifest))))
                throw new SetupFailure("SETUP_INSTALLED_PACKAGE_MISMATCH", "The installed package differs from the verified input.");
            completed = true;
            Console.WriteLine(ResultJson(
                suite ? "PASS_SUITE_SETUP_INSTALLED" : "PASS_CORE_SETUP_INSTALLED",
                true,
                target,
                shortcuts.Value,
                digest,
                packageRoot,
                extractionRoot,
                suite));
            return 0;
        }
        finally
        {
            if (completed)
            {
                try
                {
                    if (Directory.Exists(extractionRoot))
                        Directory.Delete(extractionRoot, true);
                }
                catch
                {
                    // Cleanup failure does not invalidate an already verified install.
                }
            }
            else if (Directory.Exists(extractionRoot))
            {
                Console.Error.WriteLine("SETUP_EXTRACTION_PRESERVED: " + extractionRoot);
            }
        }
    }

    private static void PrintHelp()
    {
        Console.WriteLine("DreamMaker Setup.exe");
        Console.WriteLine("  (no arguments)       Install for the current user and create shortcuts");
        Console.WriteLine("  --target <path>      Install into an absolute directory");
        Console.WriteLine("  --shortcuts          Create owned Start Menu shortcuts");
        Console.WriteLine("  --no-shortcuts       Do not change the Start Menu");
        Console.WriteLine("  --verify-only        Verify and unpack, but do not install");
        Console.WriteLine("  --help               Show this help");
        Console.WriteLine("Accepts an unsigned verified core package or complete local Suite.");
    }

    private static string DefaultInstallTarget()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (String.IsNullOrWhiteSpace(local))
            throw new SetupFailure("SETUP_LOCALAPPDATA_MISSING", "The current user's local application directory is unavailable.");
        return Path.Combine(local, "Programs", "DreamMakerSuite");
    }

    private static string ValidateTarget(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.IndexOf('"') >= 0 || value.IndexOf('\0') >= 0)
            throw new SetupFailure("SETUP_TARGET_INVALID", "The installation target is invalid.");
        if (!Path.IsPathRooted(value))
            throw new SetupFailure("SETUP_TARGET_INVALID", "The installation target must be absolute.");
        string target = Path.GetFullPath(value);
        string parent = Path.GetDirectoryName(target);
        if (String.IsNullOrEmpty(parent) || String.Equals(target, Path.GetPathRoot(target), StringComparison.OrdinalIgnoreCase))
            throw new SetupFailure("SETUP_TARGET_INVALID", "The installation target cannot be a drive root.");
        return target;
    }

    private static long ReadTrailer(string executable, out byte[] digest, out long payloadOffset)
    {
        FileInfo info = new FileInfo(executable);
        if (!info.Exists || info.Length <= TrailerBytes)
            throw new SetupFailure("SETUP_PAYLOAD_MISSING", "The executable has no embedded payload.");
        byte[] marker = Encoding.ASCII.GetBytes(MarkerText);
        digest = new byte[HashBytes];
        long payloadLength;
        using (FileStream stream = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            byte[] tail = new byte[TrailerBytes];
            stream.Seek(-TrailerBytes, SeekOrigin.End);
            ReadExactly(stream, tail, 0, tail.Length);
            for (int i = 0; i < marker.Length; i++)
                if (tail[TrailerBytes - MarkerBytes + i] != marker[i])
                    throw new SetupFailure("SETUP_PAYLOAD_MARKER_MISSING", "The embedded setup marker is missing.");
            payloadLength = ReadInt64(tail, HashBytes);
            if (payloadLength <= 0 || payloadLength > MaxPayloadBytes || payloadLength > info.Length - TrailerBytes)
                throw new SetupFailure("SETUP_PAYLOAD_LENGTH_INVALID", "The embedded payload length is invalid.");
            Buffer.BlockCopy(tail, 0, digest, 0, HashBytes);
            payloadOffset = info.Length - TrailerBytes - payloadLength;
        }
        return payloadLength;
    }

    private static void VerifyPayload(string executable, long offset, long length, byte[] expected)
    {
        byte[] actual;
        using (FileStream stream = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (SHA256 sha = SHA256.Create())
        {
            stream.Seek(offset, SeekOrigin.Begin);
            actual = sha.ComputeHash(new BoundedReadStream(stream, length));
        }
        if (!ConstantTimeEqual(actual, expected))
            throw new SetupFailure("SETUP_PAYLOAD_DIGEST_MISMATCH", "The embedded package changed or is damaged.");
    }

    private static string CreateExtractionRoot(byte[] digest)
    {
        string baseRoot = Path.GetTempPath();
        if (String.IsNullOrWhiteSpace(baseRoot))
            throw new SetupFailure("SETUP_TEMP_MISSING", "The current user's temporary directory is unavailable.");
        string parent = Path.Combine(baseRoot, "DreamMakerSuite", "Setup");
        Directory.CreateDirectory(parent);
        string prefix = BitConverter.ToString(digest, 0, 6).Replace("-", "").ToLowerInvariant();
        string root = Path.Combine(parent, prefix + "-" + DateTime.UtcNow.Ticks + "-" + Process.GetCurrentProcess().Id);
        Directory.CreateDirectory(root);
        return root;
    }

    private static void ExtractPayload(string executable, long offset, long length, string root)
    {
        string archivePath = Path.Combine(root, ".payload.zip");
        using (FileStream source = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (BoundedReadStream bounded = new BoundedReadStream(source, length))
        using (FileStream archiveCopy = new FileStream(archivePath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            source.Seek(offset, SeekOrigin.Begin);
            CopyBounded(bounded, archiveCopy, length);
        }
        try
        {
            using (FileStream archiveStream = new FileStream(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (ZipArchive archive = new ZipArchive(archiveStream, ZipArchiveMode.Read, false))
            {
                if (archive.Entries.Count <= 0 || archive.Entries.Count > MaxEntries)
                    throw new SetupFailure("SETUP_ZIP_ENTRY_COUNT_INVALID", "The package entry count is invalid.");
                HashSet<string> paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                long total = 0;
                string rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string name = SafeEntryName(entry.FullName);
                    if (!paths.Add(name))
                        throw new SetupFailure("SETUP_ZIP_DUPLICATE_PATH", name);
                    if (IsSymbolicLink(entry))
                        throw new SetupFailure("SETUP_ZIP_LINK_DENIED", name);
                    if (entry.Length < 0 || entry.Length > MaxEntryBytes)
                        throw new SetupFailure("SETUP_ZIP_ENTRY_SIZE_INVALID", name);
                    total = checked(total + entry.Length);
                    if (total > MaxExtractedBytes)
                        throw new SetupFailure("SETUP_ZIP_SIZE_INVALID", "The expanded package is too large.");
                    string full = Path.GetFullPath(Path.Combine(root, name.Replace('/', Path.DirectorySeparatorChar)));
                    if (!full.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase))
                        throw new SetupFailure("SETUP_ZIP_PATH_ESCAPE", name);
                    bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal);
                    if (directory)
                    {
                        Directory.CreateDirectory(full);
                        continue;
                    }
                    string parent = Path.GetDirectoryName(full);
                    if (String.IsNullOrEmpty(parent))
                        throw new SetupFailure("SETUP_ZIP_PATH_INVALID", name);
                    Directory.CreateDirectory(parent);
                    using (Stream input = entry.Open())
                    using (FileStream output = new FileStream(full, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        CopyBounded(input, output, entry.Length);
                }
            }
        }
        finally
        {
            if (File.Exists(archivePath))
                File.Delete(archivePath);
        }
    }

    private static string SafeEntryName(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length > 500 || value.IndexOf('\\') >= 0 ||
            value.IndexOf('\0') >= 0 || value.StartsWith("/", StringComparison.Ordinal) ||
            (value.Length > 1 && Char.IsLetter(value[0]) && value[1] == ':'))
            throw new SetupFailure("SETUP_ZIP_PATH_INVALID", "The package contains an invalid path.");
        string[] parts = value.TrimEnd('/').Split('/');
        foreach (string part in parts)
        {
            if (part.Length == 0 || part == "." || part == ".." ||
                part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) ||
                System.Text.RegularExpressions.Regex.IsMatch(part,
                    @"^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant))
                throw new SetupFailure("SETUP_ZIP_PATH_INVALID", value);
            foreach (char c in part)
                if (c < 32 || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|')
                    throw new SetupFailure("SETUP_ZIP_PATH_INVALID", value);
        }
        return value.TrimEnd('/');
    }

    private static bool IsSymbolicLink(ZipArchiveEntry entry)
    {
        int mode = (entry.ExternalAttributes >> 16) & 0xFFFF;
        return (mode & 0xF000) == 0xA000;
    }

    private static string FindPackageRoot(string extractionRoot, out bool suite)
    {
        List<string> coreFound = new List<string>();
        List<string> suiteFound = new List<string>();
        Queue<string> pending = new Queue<string>();
        pending.Enqueue(extractionRoot);
        while (pending.Count > 0)
        {
            string directory = pending.Dequeue();
            if (File.Exists(Path.Combine(directory, "SUITE_COMPOSITION_MANIFEST.json")))
            {
                suiteFound.Add(directory);
                continue;
            }
            if (File.Exists(Path.Combine(directory, "RELEASE_MANIFEST.json")))
            {
                coreFound.Add(directory);
                continue;
            }
            foreach (string child in Directory.GetDirectories(directory))
            {
                FileAttributes attributes = File.GetAttributes(child);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new SetupFailure("SETUP_EXTRACTION_LINK_DENIED", child);
                pending.Enqueue(child);
            }
        }
        if (suiteFound.Count + coreFound.Count != 1)
            throw new SetupFailure("SETUP_PACKAGE_ROOT_INVALID", "The package must contain exactly one core or Suite root.");
        suite = suiteFound.Count == 1;
        return suite ? suiteFound[0] : coreFound[0];
    }

    private static void RunPackageVerifier(string packageRoot, bool suite)
    {
        string node = suite
            ? Path.Combine(packageRoot, "core", "runtime", "node.exe")
            : Path.Combine(packageRoot, "runtime", "node.exe");
        string verifier = suite
            ? Path.Combine(packageRoot, "verify-suite-composition.mjs")
            : Path.Combine(packageRoot, "verify-portable.mjs");
        if (!File.Exists(node) || !File.Exists(verifier))
            throw new SetupFailure("SETUP_PACKAGE_VERIFIER_MISSING", "The package verifier or bundled Node runtime is missing.");
        ProcessResult result = RunProcess(node, Quote(verifier), packageRoot);
        if (result.ExitCode != 0)
            throw new SetupFailure("SETUP_PACKAGE_VERIFY_FAILED", Tail(result.Error + "\n" + result.Output));
    }

    private static void PrepareTargetParent(string target)
    {
        string parent = Path.GetDirectoryName(target);
        if (String.IsNullOrEmpty(parent))
            throw new SetupFailure("SETUP_TARGET_INVALID", "The installation target has no parent.");
        if (!Directory.Exists(parent))
        {
            string ancestor = parent;
            while (!String.IsNullOrEmpty(ancestor) && !Directory.Exists(ancestor))
                ancestor = Path.GetDirectoryName(ancestor);
            if (String.IsNullOrEmpty(ancestor))
                throw new SetupFailure("SETUP_TARGET_PARENT_INVALID", "No existing parent directory is available.");
            Directory.CreateDirectory(parent);
        }
        FileAttributes attributes = File.GetAttributes(parent);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new SetupFailure("SETUP_TARGET_PARENT_LINK_DENIED", "The installation parent may not be a link.");
    }

    private static void RunInstaller(string packageRoot, string target, bool shortcuts)
    {
        string setup = Path.Combine(packageRoot, "Setup-DreamMakerSuite.ps1");
        if (!File.Exists(setup))
            throw new SetupFailure("SETUP_SCRIPT_MISSING", "Setup-DreamMakerSuite.ps1 is missing.");
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string powerShell = Path.Combine(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (!File.Exists(powerShell))
            throw new SetupFailure("SETUP_POWERSHELL_MISSING", "Windows PowerShell is unavailable.");
        string arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(setup) +
            " -InstallDir " + Quote(target) + (shortcuts ? " -CreateShortcuts" : "");
        ProcessResult result = RunProcess(powerShell, arguments, packageRoot);
        if (result.ExitCode != 0)
            throw new SetupFailure("SETUP_INSTALL_FAILED", Tail(result.Error + "\n" + result.Output));
    }

    private static ProcessResult RunProcess(string executable, string arguments, string workingDirectory)
    {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = arguments;
        start.WorkingDirectory = workingDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (Process process = new Process())
        {
            process.StartInfo = start;
            StringBuilder output = new StringBuilder();
            StringBuilder error = new StringBuilder();
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs line)
            {
                if (line.Data != null && output.Length < 256 * 1024)
                    output.AppendLine(line.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs line)
            {
                if (line.Data != null && error.Length < 256 * 1024)
                    error.AppendLine(line.Data);
            };
            if (!process.Start())
                throw new SetupFailure("SETUP_PROCESS_START_FAILED", executable);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            return new ProcessResult { ExitCode = process.ExitCode, Output = output.ToString(), Error = error.ToString() };
        }
    }

    private static string ResultJson(
        string status,
        bool installed,
        string target,
        bool shortcuts,
        byte[] digest,
        string packageRoot,
        string extractionRoot,
        bool suite)
    {
        return "{" +
            "\"schema\":\"dream-maker.windows-setup-bootstrapper.v1\"," +
            "\"status\":\"" + Json(status) + "\"," +
            "\"installed\":" + (installed ? "true" : "false") + "," +
            "\"target\":\"" + Json(target) + "\"," +
            "\"shortcuts\":" + (shortcuts ? "true" : "false") + "," +
            "\"payloadSha256\":\"" + Hex(digest) + "\"," +
            "\"packageRoot\":\"" + Json(packageRoot) + "\"," +
            "\"extractionRoot\":\"" + Json(extractionRoot) + "\"," +
            "\"packageKind\":\"" + (suite ? "SUITE" : "CORE") + "\"," +
            "\"scope\":\"" + (suite ? "COMPLETE_LOCAL_SUITE_NOT_RELEASE" : "CORE_PACKAGE_ONLY") + "\"," +
            "\"signed\":false," +
            "\"cleanWindows\":\"NOT_VERIFIED\"," +
            "\"nativeRoles\":\"" + (suite ? "PACKAGED_NOT_QUALIFIED" : "NOT_BUNDLED") + "\"" +
            "}";
    }

    private static string Json(string value)
    {
        if (value == null)
            return "";
        StringBuilder output = new StringBuilder(value.Length + 16);
        foreach (char c in value)
        {
            if (c == '\\' || c == '"')
                output.Append('\\').Append(c);
            else if (c == '\r')
                output.Append("\\r");
            else if (c == '\n')
                output.Append("\\n");
            else if (c == '\t')
                output.Append("\\t");
            else if (c < 32)
                output.Append("\\u").Append(((int)c).ToString("x4"));
            else
                output.Append(c);
        }
        return output.ToString();
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string Tail(string value)
    {
        if (String.IsNullOrWhiteSpace(value))
            return "No child-process output.";
        value = value.Trim();
        return value.Length <= 2000 ? value : value.Substring(value.Length - 2000);
    }

    private static string Hex(byte[] value)
    {
        StringBuilder output = new StringBuilder(value.Length * 2);
        foreach (byte b in value)
            output.Append(b.ToString("x2"));
        return output.ToString();
    }

    private static bool ConstantTimeEqual(byte[] left, byte[] right)
    {
        if (left == null || right == null || left.Length != right.Length)
            return false;
        int different = 0;
        for (int i = 0; i < left.Length; i++)
            different |= left[i] ^ right[i];
        return different == 0;
    }

    private static long ReadInt64(byte[] value, int offset)
    {
        ulong result = 0;
        for (int i = 7; i >= 0; i--)
            result = (result << 8) | value[offset + i];
        if (result > Int64.MaxValue)
            return -1;
        return (long)result;
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int offset, int count)
    {
        while (count > 0)
        {
            int read = stream.Read(buffer, offset, count);
            if (read <= 0)
                throw new EndOfStreamException();
            offset += read;
            count -= read;
        }
    }

    private static void CopyBounded(Stream input, Stream output, long length)
    {
        byte[] buffer = new byte[128 * 1024];
        long remaining = length;
        while (remaining > 0)
        {
            int want = remaining > buffer.Length ? buffer.Length : (int)remaining;
            int read = input.Read(buffer, 0, want);
            if (read <= 0)
                throw new SetupFailure("SETUP_ZIP_TRUNCATED", "The package changed while it was being read.");
            output.Write(buffer, 0, read);
            remaining -= read;
        }
        if (input.ReadByte() != -1)
            throw new SetupFailure("SETUP_ZIP_ENTRY_LENGTH_CHANGED", "A package entry is larger than declared.");
    }

    private sealed class BoundedReadStream : Stream
    {
        private readonly Stream inner;
        private readonly long totalLength;
        private long remaining;
        private long position;

        internal BoundedReadStream(Stream inner, long length)
        {
            this.inner = inner;
            remaining = length;
            totalLength = length;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return totalLength; } }
        public override long Position
        {
            get { return position; }
            set { throw new NotSupportedException(); }
        }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (remaining <= 0)
                return 0;
            if (count > remaining)
                count = (int)remaining;
            int read = inner.Read(buffer, offset, count);
            if (read > 0)
            {
                remaining -= read;
                position += read;
            }
            return read;
        }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
                inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
