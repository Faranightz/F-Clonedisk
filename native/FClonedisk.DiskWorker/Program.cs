using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace FClonedisk.DiskWorker;

/// <summary>
/// Processus séparé (Windows x64) dédié aux opérations bas-niveau sur \\.\PhysicalDriveN :
/// - wipe        : passes d'écriture réelles (zero, random, dod3, dod7)
/// - clone       : copie brute secteur par secteur alignée 4 Mo
/// - surface     : test de surface réel avec mesure de latence et détection de secteurs défectueux
/// Aucune logique native dans le renderer Electron. Tous les arguments sont strictement validés.
/// </summary>
internal static class Program
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_NO_BUFFERING = 0x20000000;
    private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
    private const uint IOCTL_DISK_GET_LENGTH_INFO = 0x0007405C;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice,
        uint dwIoControlCode,
        IntPtr lpInBuffer,
        uint nInBufferSize,
        out long lpOutBuffer,
        uint nOutBufferSize,
        out uint lpBytesReturned,
        IntPtr lpOverlapped);

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            EmitError("Usage: FClonedisk.DiskWorker <wipe|clone|surface> [options]");
            return 2;
        }

        try
        {
            var command = args[0].ToLowerInvariant();
            var options = ParseArgs(args.Skip(1).ToArray());

            return command switch
            {
                "wipe" => RunWipe(options),
                "clone" => RunClone(options),
                "surface" => RunSurfaceTest(options),
                _ => throw new ArgumentException($"Commande inconnue : {command}")
            };
        }
        catch (Exception ex)
        {
            EmitError(ex.Message);
            return 1;
        }
    }

    private static Dictionary<string, string> ParseArgs(string[] args)
    {
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i].StartsWith("--"))
            {
                var eq = args[i].IndexOf('=');
                if (eq > 2)
                {
                    dict[args[i].Substring(2, eq - 2)] = args[i].Substring(eq + 1);
                }
                else if (i + 1 < args.Length)
                {
                    dict[args[i].Substring(2)] = args[++i];
                }
            }
        }
        return dict;
    }

    private static int RequireDiskNumber(Dictionary<string, string> opts, string key)
    {
        if (!opts.TryGetValue(key, out var raw) || !int.TryParse(raw, out var num) || num < 0 || num > 255)
            throw new ArgumentException($"Numéro de disque invalide (--{key}).");
        return num;
    }

    private static SafeFileHandle OpenPhysicalDrive(int diskNumber, bool write)
    {
        string path = $@"\\.\PhysicalDrive{diskNumber}";
        uint access = write ? (GENERIC_READ | GENERIC_WRITE) : GENERIC_READ;
        uint flags = write ? (FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH) : FILE_FLAG_NO_BUFFERING;
        var handle = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int err = Marshal.GetLastWin32Error();
            throw new IOException($"Impossible d'ouvrir {path} (Win32 error {err}). Droits Administrateur et disque démonté requis.");
        }
        return handle;
    }

    private static long GetDiskLengthBytes(SafeFileHandle handle)
    {
        if (!DeviceIoControl(handle, IOCTL_DISK_GET_LENGTH_INFO, IntPtr.Zero, 0, out long length, sizeof(long), out _, IntPtr.Zero))
        {
            int err = Marshal.GetLastWin32Error();
            throw new IOException($"IOCTL_DISK_GET_LENGTH_INFO a échoué (Win32 error {err}).");
        }
        return length;
    }

    private static int RunWipe(Dictionary<string, string> opts)
    {
        int diskNum = RequireDiskNumber(opts, "disk");
        string method = opts.TryGetValue("method", out var m) ? m.ToLowerInvariant() : "zero";

        string[] passes = method switch
        {
            "zero" => ["zero"],
            "random" => ["random"],
            "dod3" => ["zero", "ones", "random"],
            "dod7" => ["zero", "ones", "random", "zero", "ones", "random", "zero"],
            _ => throw new ArgumentException($"Méthode d'effacement non supportée : {method} (zero, random, dod3, dod7).")
        };

        using var handle = OpenPhysicalDrive(diskNum, write: true);
        long totalBytes = GetDiskLengthBytes(handle);
        using var fs = new FileStream(handle, FileAccess.ReadWrite, bufferSize: 4 * 1024 * 1024, isAsync: false);

        const int chunkSize = 4 * 1024 * 1024; // 4 MiB aligned
        byte[] buffer = new byte[chunkSize];
        var sw = Stopwatch.StartNew();

        for (int p = 0; p < passes.Length; p++)
        {
            string passType = passes[p];
            if (passType == "zero") Array.Clear(buffer);
            else if (passType == "ones") Array.Fill(buffer, (byte)0xFF);

            fs.Seek(0, SeekOrigin.Begin);
            long written = 0;
            while (written < totalBytes)
            {
                if (passType == "random") RandomNumberGenerator.Fill(buffer);
                int toWrite = (int)Math.Min(chunkSize, totalBytes - written);
                // Keep sector alignment (512 bytes)
                toWrite = (toWrite / 512) * 512;
                if (toWrite <= 0) break;

                fs.Write(buffer, 0, toWrite);
                written += toWrite;

                if (written % (64L * 1024 * 1024) == 0 || written >= totalBytes)
                {
                    double overallPct = ((p + (double)written / totalBytes) / passes.Length) * 100.0;
                    double mbps = sw.Elapsed.TotalSeconds > 0 ? ((p * totalBytes + written) / (1024.0 * 1024.0)) / sw.Elapsed.TotalSeconds : 0;
                    EmitJson(new { type = "progress", pass = p + 1, totalPasses = passes.Length, percent = Math.Round(overallPct, 1), mbPerSec = Math.Round(mbps, 1) });
                }
            }
            fs.Flush(true);
        }

        EmitJson(new { type = "done", disk = diskNum, method, bytesWiped = totalBytes });
        return 0;
    }

    private static int RunClone(Dictionary<string, string> opts)
    {
        int srcNum = RequireDiskNumber(opts, "src");
        int dstNum = RequireDiskNumber(opts, "dst");
        if (srcNum == dstNum) throw new ArgumentException("Les disques source et cible doivent être différents.");

        using var srcHandle = OpenPhysicalDrive(srcNum, write: false);
        using var dstHandle = OpenPhysicalDrive(dstNum, write: true);

        long srcLen = GetDiskLengthBytes(srcHandle);
        long dstLen = GetDiskLengthBytes(dstHandle);
        if (dstLen < srcLen)
            throw new InvalidOperationException($"Disque cible ({dstLen} octets) plus petit que la source ({srcLen} octets).");

        using var srcStream = new FileStream(srcHandle, FileAccess.Read, bufferSize: 4 * 1024 * 1024, isAsync: false);
        using var dstStream = new FileStream(dstHandle, FileAccess.Write, bufferSize: 4 * 1024 * 1024, isAsync: false);

        const int chunkSize = 4 * 1024 * 1024;
        byte[] buffer = new byte[chunkSize];
        long copied = 0;
        var sw = Stopwatch.StartNew();

        while (copied < srcLen)
        {
            int toRead = (int)Math.Min(chunkSize, srcLen - copied);
            toRead = (toRead / 512) * 512;
            if (toRead <= 0) break;

            int read = srcStream.Read(buffer, 0, toRead);
            if (read <= 0) break;

            dstStream.Write(buffer, 0, read);
            copied += read;

            if (copied % (64L * 1024 * 1024) == 0 || copied >= srcLen)
            {
                double pct = (double)copied / srcLen * 100.0;
                double mbps = sw.Elapsed.TotalSeconds > 0 ? (copied / (1024.0 * 1024.0)) / sw.Elapsed.TotalSeconds : 0;
                EmitJson(new { type = "progress", percent = Math.Round(pct, 1), copiedBytes = copied, totalBytes = srcLen, mbPerSec = Math.Round(mbps, 1) });
            }
        }
        dstStream.Flush(true);
        EmitJson(new { type = "done", src = srcNum, dst = dstNum, copiedBytes = copied });
        return 0;
    }

    private static int RunSurfaceTest(Dictionary<string, string> opts)
    {
        int diskNum = RequireDiskNumber(opts, "disk");
        int segments = opts.TryGetValue("segments", out var s) && int.TryParse(s, out var parsed) && parsed >= 16 && parsed <= 512 ? parsed : 192;

        using var handle = OpenPhysicalDrive(diskNum, write: false);
        long totalBytes = GetDiskLengthBytes(handle);
        using var fs = new FileStream(handle, FileAccess.Read, bufferSize: 1024 * 1024, isAsync: false);

        const int sampleSize = 1024 * 1024; // 1 MiB per sample
        byte[] buffer = new byte[sampleSize];
        long step = Math.Max(sampleSize, (totalBytes / segments / 512) * 512);
        int badCount = 0;

        for (int i = 0; i < segments; i++)
        {
            long offset = Math.Min(totalBytes - sampleSize, i * step);
            offset = Math.Max(0, (offset / 512) * 512);
            var sw = Stopwatch.StartNew();
            string status = "ok";

            try
            {
                fs.Seek(offset, SeekOrigin.Begin);
                int read = fs.Read(buffer, 0, sampleSize);
                sw.Stop();
                if (read < 512) status = "bad";
                else if (sw.ElapsedMilliseconds > 250) status = "slow";
            }
            catch
            {
                sw.Stop();
                status = "bad";
                badCount++;
            }

            EmitJson(new
            {
                type = "sector",
                index = i,
                total = segments,
                status,
                latencyMs = sw.ElapsedMilliseconds,
                percent = Math.Round(((i + 1.0) / segments) * 100.0, 1)
            });
        }

        EmitJson(new { type = "done", disk = diskNum, segments, badCount });
        return 0;
    }

    private static void EmitJson(object payload)
    {
        Console.WriteLine(JsonSerializer.Serialize(payload));
    }

    private static void EmitError(string message)
    {
        Console.Error.WriteLine(JsonSerializer.Serialize(new { type = "error", error = message }));
    }
}
