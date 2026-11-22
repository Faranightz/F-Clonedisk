using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace FClonedisk.DiskWorker;

/// <summary>
/// Processus séparé (Windows x64) dédié aux opérations bas-niveau sur \\.\PhysicalDriveN :
/// - wipe     : passes d'écriture réelles (zero, random, dod3, dod7)
/// - clone    : copie brute secteur par secteur, puis nouvel identifiant de disque
///              (GUID GPT ou signature MBR) et en-tête GPT de secours replacé en fin de disque
/// - regen-id : seulement la seconde partie du clonage, sur un disque déjà copié
/// - surface  : test de surface rapide (échantillon) ou complet (tout le disque)
///
/// Les disques doivent être mis hors ligne par l'appelant (Electron) avant toute écriture :
/// Windows refuse d'écrire sur les zones d'un volume monté.
/// Toutes les E/S passent par des tampons alignés sur 4096 octets (exigé par FILE_FLAG_NO_BUFFERING)
/// et par RandomAccess (aucun tampon FileStream intermédiaire).
/// </summary>
internal static unsafe class Program
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_NO_BUFFERING = 0x20000000;
    private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
    private const uint IOCTL_DISK_GET_LENGTH_INFO = 0x0007405C;
    private const uint IOCTL_DISK_GET_DRIVE_GEOMETRY = 0x00070000;

    private const int ALIGNMENT = 4096;
    private const int CHUNK = 4 * 1024 * 1024; // 4 Mio, multiple de 4096
    private const long PROGRESS_EVERY = 64L * 1024 * 1024;

    [StructLayout(LayoutKind.Sequential)]
    private struct DiskGeometry
    {
        public long Cylinders;
        public int MediaType;
        public int TracksPerCylinder;
        public int SectorsPerTrack;
        public int BytesPerSector;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes,
        uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize,
        out long lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "DeviceIoControl")]
    private static extern bool DeviceIoControlGeometry(
        SafeFileHandle hDevice, uint dwIoControlCode, IntPtr lpInBuffer, uint nInBufferSize,
        out DiskGeometry lpOutBuffer, uint nOutBufferSize, out uint lpBytesReturned, IntPtr lpOverlapped);

    /// <summary>Tampon natif aligné sur 4096 octets, libéré à la fin du using.</summary>
    private sealed unsafe class AlignedBuffer : IDisposable
    {
        private void* _ptr;
        public int Length { get; }

        public AlignedBuffer(int length)
        {
            if (length <= 0 || length % ALIGNMENT != 0) throw new ArgumentException("Taille de tampon non alignée.");
            Length = length;
            _ptr = NativeMemory.AlignedAlloc((nuint)length, ALIGNMENT);
            NativeMemory.Clear(_ptr, (nuint)length);
        }

        public Span<byte> Span => new(_ptr, Length);

        public void Dispose()
        {
            if (_ptr != null)
            {
                NativeMemory.AlignedFree(_ptr);
                _ptr = null;
            }
        }
    }

    private sealed class Drive : IDisposable
    {
        public required SafeFileHandle Handle { get; init; }
        public required long Length { get; init; }
        public required int SectorSize { get; init; }
        public void Dispose() => Handle.Dispose();
    }

    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            EmitError("Usage: FClonedisk.DiskWorker <wipe|clone|regen-id|surface> [options]");
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
                "regen-id" => RunRegenId(options),
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
            if (!args[i].StartsWith("--")) continue;
            var eq = args[i].IndexOf('=');
            if (eq > 2) dict[args[i].Substring(2, eq - 2)] = args[i].Substring(eq + 1);
            else if (i + 1 < args.Length) dict[args[i].Substring(2)] = args[++i];
        }
        return dict;
    }

    private static int RequireDiskNumber(Dictionary<string, string> opts, string key)
    {
        if (!opts.TryGetValue(key, out var raw) || !int.TryParse(raw, out var num) || num < 0 || num > 255)
            throw new ArgumentException($"Numéro de disque invalide (--{key}).");
        return num;
    }

    private static Drive OpenDrive(int diskNumber, bool write)
    {
        string path = $@"\\.\PhysicalDrive{diskNumber}";
        uint access = write ? (GENERIC_READ | GENERIC_WRITE) : GENERIC_READ;
        uint flags = write ? (FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH) : FILE_FLAG_NO_BUFFERING;
        var handle = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int err = Marshal.GetLastWin32Error();
            throw new IOException($"Impossible d'ouvrir {path} (erreur Win32 {err}). Droits Administrateur et disque hors ligne requis.");
        }

        if (!DeviceIoControl(handle, IOCTL_DISK_GET_LENGTH_INFO, IntPtr.Zero, 0, out long length, sizeof(long), out _, IntPtr.Zero))
        {
            int err = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new IOException($"IOCTL_DISK_GET_LENGTH_INFO a échoué sur {path} (erreur Win32 {err}).");
        }

        if (!DeviceIoControlGeometry(handle, IOCTL_DISK_GET_DRIVE_GEOMETRY, IntPtr.Zero, 0, out var geo, (uint)sizeof(DiskGeometry), out _, IntPtr.Zero))
        {
            int err = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new IOException($"IOCTL_DISK_GET_DRIVE_GEOMETRY a échoué sur {path} (erreur Win32 {err}).");
        }

        int sector = geo.BytesPerSector;
        if (sector != 512 && sector != 4096)
        {
            handle.Dispose();
            throw new IOException($"Taille de secteur non prise en charge sur {path} : {sector} octets.");
        }
        if (length <= 0 || length % sector != 0)
        {
            handle.Dispose();
            throw new IOException($"Taille de disque incohérente sur {path} : {length} octets.");
        }

        return new Drive { Handle = handle, Length = length, SectorSize = sector };
    }

    // ---------- Effacement ----------

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

        using var drive = OpenDrive(diskNum, write: true);
        using var buffer = new AlignedBuffer(CHUNK);
        long total = drive.Length;
        var sw = Stopwatch.StartNew();

        for (int p = 0; p < passes.Length; p++)
        {
            string passType = passes[p];
            if (passType == "zero") buffer.Span.Clear();
            else if (passType == "ones") buffer.Span.Fill(0xFF);

            long written = 0;
            while (written < total)
            {
                int toWrite = (int)Math.Min(CHUNK, total - written); // total est un multiple de la taille de secteur
                var span = buffer.Span[..toWrite];
                if (passType == "random") RandomNumberGenerator.Fill(span);

                RandomAccess.Write(drive.Handle, span, written);
                written += toWrite;

                if (written % PROGRESS_EVERY == 0 || written >= total)
                {
                    double overallPct = (p + (double)written / total) / passes.Length * 100.0;
                    double mbps = sw.Elapsed.TotalSeconds > 0 ? (p * total + written) / (1024.0 * 1024.0) / sw.Elapsed.TotalSeconds : 0;
                    EmitJson(new { type = "progress", pass = p + 1, totalPasses = passes.Length, percent = Math.Round(overallPct, 1), mbPerSec = Math.Round(mbps, 1) });
                }
            }
        }

        EmitJson(new { type = "done", disk = diskNum, method, bytesWiped = total });
        return 0;
    }

    // ---------- Clonage ----------

    private static int RunClone(Dictionary<string, string> opts)
    {
        int srcNum = RequireDiskNumber(opts, "src");
        int dstNum = RequireDiskNumber(opts, "dst");
        if (srcNum == dstNum) throw new ArgumentException("Les disques source et cible doivent être différents.");

        using var src = OpenDrive(srcNum, write: false);
        using var dst = OpenDrive(dstNum, write: true);

        if (src.SectorSize != dst.SectorSize)
            throw new InvalidOperationException(
                $"Tailles de secteur différentes (source {src.SectorSize} o, cible {dst.SectorSize} o) : un clone brut rendrait la table de partitions illisible.");
        if (dst.Length < src.Length)
            throw new InvalidOperationException($"Disque cible ({dst.Length} octets) plus petit que la source ({src.Length} octets).");

        using var buffer = new AlignedBuffer(CHUNK);
        long copied = 0;
        var sw = Stopwatch.StartNew();

        while (copied < src.Length)
        {
            int toRead = (int)Math.Min(CHUNK, src.Length - copied);
            var span = buffer.Span[..toRead];
            int read = RandomAccess.Read(src.Handle, span, copied);
            if (read != toRead)
                throw new IOException($"Lecture incomplète de la source à l'octet {copied} ({read}/{toRead}). Clonage arrêté.");

            RandomAccess.Write(dst.Handle, span, copied);
            copied += read;

            if (copied % PROGRESS_EVERY == 0 || copied >= src.Length)
            {
                double pct = (double)copied / src.Length * 100.0;
                double mbps = sw.Elapsed.TotalSeconds > 0 ? copied / (1024.0 * 1024.0) / sw.Elapsed.TotalSeconds : 0;
                EmitJson(new { type = "progress", percent = Math.Round(pct * 0.98, 1), copiedBytes = copied, totalBytes = src.Length, mbPerSec = Math.Round(mbps, 1) });
            }
        }

        var idResult = RegenerateDiskIdentity(dst, src.Length);
        EmitJson(new { type = "progress", percent = 100.0, copiedBytes = copied, totalBytes = src.Length, mbPerSec = 0.0 });
        EmitJson(new { type = "done", src = srcNum, dst = dstNum, copiedBytes = copied, partitionStyle = idResult.Style, newDiskId = idResult.NewId });
        return 0;
    }

    private static int RunRegenId(Dictionary<string, string> opts)
    {
        int diskNum = RequireDiskNumber(opts, "disk");
        using var drive = OpenDrive(diskNum, write: true);
        long previousLen = drive.Length;
        if (opts.TryGetValue("source-length", out var raw) && long.TryParse(raw, out var parsed) && parsed > 0 && parsed <= drive.Length)
            previousLen = parsed;
        var res = RegenerateDiskIdentity(drive, previousLen);
        EmitJson(new { type = "done", disk = diskNum, partitionStyle = res.Style, newDiskId = res.NewId });
        return 0;
    }

    private readonly record struct IdResult(string Style, string NewId);

    /// <summary>
    /// Après un clone brut, le disque cible porte le même identifiant que la source :
    /// Windows mettrait l'un des deux hors ligne (collision de signature).
    /// GPT : nouveau GUID de disque, en-tête et table de secours replacés en fin de disque, CRC recalculés.
    /// MBR : nouvelle signature de disque (offset 440).
    /// </summary>
    private static IdResult RegenerateDiskIdentity(Drive drive, long sourceLength)
    {
        int ss = drive.SectorSize;
        long lastLba = drive.Length / ss - 1;
        byte[] lba0 = ReadSectors(drive, 0, 1);

        bool hasBootSig = lba0[510] == 0x55 && lba0[511] == 0xAA;
        bool protectiveMbr = false;
        for (int i = 0; i < 4; i++)
            if (lba0[446 + i * 16 + 4] == 0xEE) protectiveMbr = true;

        if (!hasBootSig)
            return new IdResult("NONE", "");

        if (!protectiveMbr)
        {
            uint sig;
            do { sig = BinaryPrimitives.ReadUInt32LittleEndian(RandomNumberGenerator.GetBytes(4)); } while (sig == 0);
            BinaryPrimitives.WriteUInt32LittleEndian(lba0.AsSpan(440, 4), sig);
            WriteSectors(drive, 0, lba0);
            return new IdResult("MBR", sig.ToString("X8"));
        }

        byte[] header = ReadSectors(drive, 1, 1);
        if (System.Text.Encoding.ASCII.GetString(header, 0, 8) != "EFI PART")
            throw new InvalidDataException("En-tête GPT introuvable en LBA 1 sur le disque cible.");

        uint headerSize = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(12, 4));
        long entriesLba = (long)BinaryPrimitives.ReadUInt64LittleEndian(header.AsSpan(72, 8));
        uint numEntries = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(80, 4));
        uint entrySize = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(84, 4));
        if (headerSize < 92 || headerSize > ss || numEntries == 0 || numEntries > 1024 || entrySize < 128 || entrySize > 1024)
            throw new InvalidDataException("En-tête GPT invalide sur le disque cible.");

        int entriesBytes = checked((int)(numEntries * entrySize));
        int entriesSectors = (entriesBytes + ss - 1) / ss;
        byte[] entries = ReadSectors(drive, entriesLba, entriesSectors);
        uint entriesCrc = Crc32(entries.AsSpan(0, entriesBytes));

        long newBackupEntriesLba = lastLba - entriesSectors;
        long newLastUsable = newBackupEntriesLba - 1;
        long oldLastLba = sourceLength / ss - 1;

        var newGuid = Guid.NewGuid();
        newGuid.ToByteArray().CopyTo(header, 56); // format GUID mixte, identique à celui du GPT

        // En-tête principal
        WriteU64(header, 24, 1);
        WriteU64(header, 32, (ulong)lastLba);
        WriteU64(header, 48, (ulong)newLastUsable);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(88, 4), entriesCrc);
        SetHeaderCrc(header, headerSize);

        // En-tête de secours
        byte[] backup = (byte[])header.Clone();
        WriteU64(backup, 24, (ulong)lastLba);
        WriteU64(backup, 32, 1);
        WriteU64(backup, 72, (ulong)newBackupEntriesLba);
        SetHeaderCrc(backup, headerSize);

        // L'ancien en-tête de secours (fin de la source) devient de l'espace libre : on l'efface
        if (oldLastLba < newBackupEntriesLba && oldLastLba > 1)
            WriteSectors(drive, oldLastLba, new byte[ss]);

        WriteSectors(drive, newBackupEntriesLba, entries);
        WriteSectors(drive, lastLba, backup);
        WriteSectors(drive, 1, header);

        // MBR protecteur : couvrir tout le disque
        uint pmbrSize = lastLba > uint.MaxValue ? uint.MaxValue : (uint)lastLba;
        for (int i = 0; i < 4; i++)
        {
            int off = 446 + i * 16;
            if (lba0[off + 4] == 0xEE) BinaryPrimitives.WriteUInt32LittleEndian(lba0.AsSpan(off + 12, 4), pmbrSize);
        }
        WriteSectors(drive, 0, lba0);

        return new IdResult("GPT", newGuid.ToString("B").ToUpperInvariant());
    }

    private static void WriteU64(byte[] buf, int offset, ulong value) =>
        BinaryPrimitives.WriteUInt64LittleEndian(buf.AsSpan(offset, 8), value);

    private static void SetHeaderCrc(byte[] header, uint headerSize)
    {
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(16, 4), 0);
        uint crc = Crc32(header.AsSpan(0, (int)headerSize));
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(16, 4), crc);
    }

    private static byte[] ReadSectors(Drive drive, long lba, int count)
    {
        int bytes = count * drive.SectorSize;
        int alignedLen = (bytes + ALIGNMENT - 1) / ALIGNMENT * ALIGNMENT;
        using var buf = new AlignedBuffer(alignedLen);
        int read = RandomAccess.Read(drive.Handle, buf.Span[..bytes], lba * drive.SectorSize);
        if (read != bytes) throw new IOException($"Lecture incomplète au LBA {lba}.");
        return buf.Span[..bytes].ToArray();
    }

    private static void WriteSectors(Drive drive, long lba, byte[] data)
    {
        if (data.Length == 0 || data.Length % drive.SectorSize != 0)
            throw new ArgumentException("Écriture non alignée sur la taille de secteur.");
        int alignedLen = (data.Length + ALIGNMENT - 1) / ALIGNMENT * ALIGNMENT;
        using var buf = new AlignedBuffer(alignedLen);
        data.CopyTo(buf.Span);
        RandomAccess.Write(drive.Handle, buf.Span[..data.Length], lba * drive.SectorSize);
    }

    private static readonly uint[] CrcTable = BuildCrcTable();

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
        return table;
    }

    private static uint Crc32(ReadOnlySpan<byte> data)
    {
        uint crc = 0xFFFFFFFFu;
        foreach (byte b in data) crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        return ~crc;
    }

    // ---------- Test de surface ----------

    private static int RunSurfaceTest(Dictionary<string, string> opts)
    {
        int diskNum = RequireDiskNumber(opts, "disk");
        int segments = opts.TryGetValue("segments", out var s) && int.TryParse(s, out var parsed) && parsed >= 16 && parsed <= 512 ? parsed : 192;
        string mode = opts.TryGetValue("mode", out var md) ? md.ToLowerInvariant() : "quick";
        if (mode != "quick" && mode != "full") throw new ArgumentException($"Mode de test inconnu : {mode} (quick, full).");

        using var drive = OpenDrive(diskNum, write: false);
        return mode == "full" ? SurfaceFull(drive, diskNum, segments) : SurfaceQuick(drive, diskNum, segments);
    }

    /// <summary>Rapide : lit 1 Mio au début de chaque segment (échantillon, pas tout le disque).</summary>
    private static int SurfaceQuick(Drive drive, int diskNum, int segments)
    {
        const int sample = 1024 * 1024;
        using var buffer = new AlignedBuffer(sample);
        long total = drive.Length;
        long step = Math.Max(sample, total / segments / ALIGNMENT * ALIGNMENT);
        int badCount = 0;

        for (int i = 0; i < segments; i++)
        {
            long offset = Math.Max(0, Math.Min(total - sample, i * step));
            offset = offset / drive.SectorSize * drive.SectorSize;
            int len = (int)Math.Min(sample, total - offset);
            var sw = Stopwatch.StartNew();
            string status = "ok";
            try
            {
                int read = RandomAccess.Read(drive.Handle, buffer.Span[..len], offset);
                sw.Stop();
                if (read < len) status = "bad";
                else if (sw.ElapsedMilliseconds > 250) status = "slow";
            }
            catch (IOException)
            {
                sw.Stop();
                status = "bad";
            }
            if (status == "bad") badCount++;

            EmitJson(new { type = "sector", index = i, total = segments, status, latencyMs = sw.ElapsedMilliseconds, percent = Math.Round((i + 1.0) / segments * 100.0, 1) });
        }

        EmitJson(new { type = "done", disk = diskNum, mode = "quick", segments, badCount, badBytes = 0L });
        return 0;
    }

    /// <summary>Complet : lit tout le disque par blocs de 4 Mio, chaque case affiche le pire bloc de sa zone.</summary>
    private static int SurfaceFull(Drive drive, int diskNum, int segments)
    {
        using var buffer = new AlignedBuffer(CHUNK);
        long total = drive.Length;
        int badChunks = 0;
        long badBytes = 0;
        int currentCell = 0;
        string cellStatus = "ok";
        long cellMaxLatency = 0;

        void FlushCell(int cell)
        {
            EmitJson(new { type = "sector", index = cell, total = segments, status = cellStatus, latencyMs = cellMaxLatency, percent = Math.Round((cell + 1.0) / segments * 100.0, 1) });
            cellStatus = "ok";
            cellMaxLatency = 0;
        }

        for (long offset = 0; offset < total; offset += CHUNK)
        {
            int cell = (int)Math.Min(segments - 1, offset * segments / total);
            while (cell > currentCell) { FlushCell(currentCell); currentCell++; }

            int len = (int)Math.Min(CHUNK, total - offset);
            var sw = Stopwatch.StartNew();
            string status = "ok";
            try
            {
                int read = RandomAccess.Read(drive.Handle, buffer.Span[..len], offset);
                sw.Stop();
                if (read < len) status = "bad";
                else if (sw.ElapsedMilliseconds > 1000) status = "slow";
            }
            catch (IOException)
            {
                sw.Stop();
                status = "bad";
            }

            if (status == "bad") { badChunks++; badBytes += len; }
            cellMaxLatency = Math.Max(cellMaxLatency, sw.ElapsedMilliseconds);
            if (status == "bad" || (status == "slow" && cellStatus == "ok")) cellStatus = status;
        }
        while (currentCell < segments) { FlushCell(currentCell); currentCell++; }

        EmitJson(new { type = "done", disk = diskNum, mode = "full", segments, badCount = badChunks, badBytes });
        return 0;
    }

    private static void EmitJson(object payload) => Console.WriteLine(JsonSerializer.Serialize(payload));

    private static void EmitError(string message) =>
        Console.Error.WriteLine(JsonSerializer.Serialize(new { type = "error", error = message }));
}
