export type FileSystemType =
  | 'NTFS'
  | 'FAT32'
  | 'exFAT'
  | 'EXT4'
  | 'EXT3'
  | 'EXT2'
  | 'ReFS'
  | 'LinuxSwap'
  | 'RAW'
  | 'Unallocated';

export type PartitionRole = 'System' | 'Boot' | 'EFI' | 'Recovery' | 'Primary' | 'Logical' | 'Unallocated';

export interface Partition {
  id: string;
  partitionNumber: number; // Real Windows PartitionNumber; 0 for Unallocated or pending-new partitions
  isPendingNew?: boolean; // True when created in queue and not yet assigned a Windows PartitionNumber
  letter: string; // e.g. "C:" or ""
  label: string;
  fileSystem: FileSystemType;
  sizeGB: number;
  usedGB: number;
  role: PartitionRole;
  isSystem?: boolean;
  isActive?: boolean;
  isHidden?: boolean;
  aligned4K: boolean;
  clusterSize: string; // e.g. "4 Ko"
}

export interface SmartMetrics {
  healthPercent: number;
  temperatureC: number | null;
  powerOnHours: number | null;
  powerCycles: number | null;
  totalWrittenTB: number | null;
  reallocatedSectors: number;
  pendingSectors: number;
  unsafeShutdowns: number;
  wearLevelPercent: number | null;
}

export interface DiskIdentity {
  diskNumber: number;
  model: string;
  serial: string;
  uniqueId?: string;
  sizeBytes: number;
  sizeGB: number;
}

export interface Disk {
  id: string;
  number: number;
  model: string;
  serial: string;
  uniqueId?: string;
  busType: 'NVMe' | 'SATA' | 'USB' | 'SAS';
  mediaType: 'SSD' | 'HDD' | 'Removable';
  partitionStyle: 'GPT' | 'MBR';
  sizeGB: number;
  sizeBytes?: number;
  status: 'En ligne' | 'Hors ligne';
  health: 'Sain' | 'Avertissement' | 'Critique';
  smart: SmartMetrics;
  partitions: Partition[];
}

export type OperationType =
  | 'create'
  | 'resize'
  | 'format'
  | 'delete'
  | 'wipe_partition'
  | 'wipe_disk'
  | 'merge'
  | 'split'
  | 'allocate'
  | 'letter'
  | 'label'
  | 'convert_gpt'
  | 'convert_mbr'
  | 'convert_fs'
  | 'align_4k'
  | 'hide'
  | 'set_active'
  | 'clone_disk'
  | 'clone_partition'
  | 'migrate_os'
  | 'rebuild_mbr'
  | 'check_partition'
  | 'recover_partition'
  | 'backup_vhdx'
  | 'app_mover';

export interface PendingOperation {
  id: string;
  type: OperationType;
  diskNumber: number;
  diskIdentity: DiskIdentity;
  partitionNumber?: number;
  title: string;
  description: string;
  commandPreview: string;
  params: Record<string, unknown>;
  createdAt: string;
}

export interface Selection {
  diskId: string;
  partitionId?: string;
}

export type ActiveModal =
  | null
  | 'create'
  | 'resize'
  | 'format'
  | 'split'
  | 'merge'
  | 'allocate'
  | 'letter'
  | 'label'
  | 'wipe'
  | 'clone_disk'
  | 'clone_partition'
  | 'migrate_os'
  | 'backup'
  | 'surface_test'
  | 'smart_bench'
  | 'recovery'
  | 'bootable_media'
  | 'app_mover'
  | 'properties'
  | 'apply';

export interface RecoverablePartition {
  id: string;
  diskNumber: number;
  label: string;
  fileSystem: FileSystemType;
  sizeGB: number;
  usedGB: number;
  filesCount: number;
  integrity: 'Excellente' | 'Bonne' | 'Partielle';
}

export interface MovableApp {
  id: string;
  name: string;
  publisher: string;
  sourceDrive: string;
  sizeGB: number;
  path: string;
}

export interface ExecutionStepResult {
  id: string;
  ok: boolean;
  command: string;
  output?: string;
  error?: string;
}

export interface ExecutionProgressEvent {
  index: number;
  total: number;
  operationId: string;
  status: 'running' | 'done' | 'error';
  command?: string;
  output?: string;
  error?: string;
  percent: number;
}

declare global {
  interface Window {
    fClonedisk?: {
      isElectron: boolean;
      platform: string;
      getSystemInfo: () => Promise<{
        platform: string;
        hostname: string;
        arch: string;
        totalMemoryGB: number;
        isWindows: boolean;
        isAdmin: boolean;
      }>;
      listDisks: () => Promise<{ supported: boolean; disks: Disk[]; reason?: string }>;
      executeOperations: (ops: PendingOperation[]) => Promise<{ cancelled: boolean; results: ExecutionStepResult[] }>;
      runSurfaceTest: (diskNumber: number, segments?: number) => Promise<unknown>;
      createWinPe: (opts: { mode: 'iso' | 'ufd'; usbLetter?: string; isoPath?: string }) => Promise<{
        ok: boolean;
        adkInstalled: boolean;
        commands: string[];
        error?: string;
      }>;
      scanTestDisk: (diskNumber: number, customPath?: string) => Promise<{
        ok: boolean;
        found: boolean;
        binaryPath?: string;
        partitions: RecoverablePartition[];
        error?: string;
      }>;
      exportLog: (logText: string) => Promise<{ saved: boolean; path?: string; error?: string }>;
      onProgress: (cb: (payload: ExecutionProgressEvent) => void) => () => void;
      onWorkerEvent: (cb: (payload: Record<string, unknown>) => void) => () => void;
    };
  }
}
