import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Copy,
  Cpu,
  Disc,
  Eraser,
  FolderSync,
  Gauge,
  HardDrive,
  Info,
  Layers,
  Play,
  PlusCircle,
  Scissors,
  Search,
  ShieldAlert,
  Sliders,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type {
  ActiveModal,
  Disk,
  ExecutionProgressEvent,
  FileSystemType,
  Partition,
  PartitionRole,
  PendingOperation,
  RecoverablePartition,
} from '../types/disk';
import { diskHasSystemPartition, formatSize, getAvailableLetters } from '../utils/diskEngine';
import { MOCK_MOVABLE_APPS, MOCK_RECOVERABLE_PARTITIONS } from '../data/mockDisks';

interface WizardsProps {
  modal: Exclude<ActiveModal, null>;
  onClose: () => void;
  disks: Disk[];
  selectedDisk?: Disk;
  selectedPartition?: Partition;
  pendingOps: PendingOperation[];
  simulationMode: boolean;
  onCreatePartition: (opts: {
    sizeGB: number;
    fileSystem: FileSystemType;
    letter: string;
    label: string;
    clusterSize: string;
    role: PartitionRole;
    aligned4K: boolean;
  }) => void;
  onResizePartition: (newSizeGB: number) => void;
  onFormatPartition: (opts: { fileSystem: FileSystemType; label: string; clusterSize: string; quick: boolean }) => void;
  onSplitPartition: (newSizeGB: number, letter: string, label: string) => void;
  onMergePartition: (sourcePartId: string) => void;
  onAllocateSpace: (toPartId: string, amountGB: number) => void;
  onChangeLetter: (letter: string) => void;
  onChangeLabel: (label: string) => void;
  onWipe: (target: 'partition' | 'disk', method: string) => void;
  onCloneDisk: (
    sourceId: string,
    targetId: string,
    opts: { mode: 'quick' | 'sector'; align4K: boolean; fitMode: 'proportional' | 'original' }
  ) => void;
  onMigrateOs: (targetDiskId: string, align4K: boolean) => void;
  onBackup: (opts: { engine: 'wbadmin' | 'vhdx'; sourceDrive: string; targetDrive: string; vhdxPath: string; sizeGB: number }) => void;
  onRecoverPartition: (rec: RecoverablePartition) => void;
  onMoveApps: (appIds: string[], targetDrive: string) => void;
  onApplyFinished: (allSucceeded: boolean) => void;
}

const ALL_FS: FileSystemType[] = ['NTFS', 'FAT32', 'exFAT', 'EXT4', 'EXT3', 'EXT2', 'ReFS', 'LinuxSwap'];
const WINDOWS_NATIVE_FS: FileSystemType[] = ['NTFS', 'FAT32', 'exFAT', 'ReFS'];
const CLUSTERS = ['Par défaut', '4 Ko', '8 Ko', '16 Ko', '32 Ko', '64 Ko', '128 Ko'];

export const Wizards: React.FC<WizardsProps> = (props) => {
  const { modal, onClose, disks, selectedDisk, selectedPartition, pendingOps, simulationMode } = props;

  const availableLetters = useMemo(() => getAvailableLetters(disks), [disks]);
  const fsChoices = simulationMode ? ALL_FS : WINDOWS_NATIVE_FS;

  // Create Anything state
  const maxCreateGB = selectedPartition?.fileSystem === 'Unallocated' ? selectedPartition.sizeGB : 1;
  const [createSize, setCreateSize] = useState<number>(maxCreateGB);
  const [createFs, setCreateFs] = useState<FileSystemType>('NTFS');
  const [createLetter, setCreateLetter] = useState<string>(availableLetters[0] || '');
  const [createLabel, setCreateLabel] = useState<string>('Nouveau volume');
  const [createCluster, setCreateCluster] = useState<string>('4 Ko');
  const [createRole, setCreateRole] = useState<PartitionRole>('Primary');
  const [createAlign4K, setCreateAlign4K] = useState<boolean>(true);

  // Resize state
  const maxExtendable = useMemo(() => {
    if (!selectedDisk || !selectedPartition) return selectedPartition?.sizeGB || 1;
    const idx = selectedDisk.partitions.findIndex((p) => p.id === selectedPartition.id);
    let extra = 0;
    const right = selectedDisk.partitions[idx + 1];
    const left = selectedDisk.partitions[idx - 1];
    if (right?.fileSystem === 'Unallocated') extra += right.sizeGB;
    if (left?.fileSystem === 'Unallocated') extra += left.sizeGB;
    return Number((selectedPartition.sizeGB + extra).toFixed(1));
  }, [selectedDisk, selectedPartition]);
  const minShrinkable = selectedPartition
    ? Number(Math.min(maxExtendable, Math.max(selectedPartition.usedGB + 1, 0.5)).toFixed(1))
    : 0.5;
  const [resizeSize, setResizeSize] = useState<number>(
    Math.min(maxExtendable, Math.max(minShrinkable, selectedPartition?.sizeGB || 1))
  );

  // Format state
  const [fmtFs, setFmtFs] = useState<FileSystemType>(
    selectedPartition?.fileSystem && selectedPartition.fileSystem !== 'Unallocated' && fsChoices.includes(selectedPartition.fileSystem)
      ? selectedPartition.fileSystem
      : 'NTFS'
  );
  const [fmtLabel, setFmtLabel] = useState<string>(selectedPartition?.label || 'Volume');
  const [fmtCluster, setFmtCluster] = useState<string>(selectedPartition?.clusterSize || '4 Ko');
  const [fmtQuick, setFmtQuick] = useState<boolean>(true);

  // Split state
  const maxSplit = selectedPartition
    ? Number((selectedPartition.sizeGB - Math.max(selectedPartition.usedGB + 2, 1)).toFixed(1))
    : 0;
  const [splitSize, setSplitSize] = useState<number>(maxSplit >= 1 ? Number(Math.max(1, maxSplit / 2).toFixed(1)) : 1);
  const [splitLetter, setSplitLetter] = useState<string>(availableLetters[0] || '');
  const [splitLabel, setSplitLabel] = useState<string>('Partition 2');

  // Merge / Allocate state
  const siblingPartitions = useMemo(() => {
    if (!selectedDisk || !selectedPartition) return [];
    return selectedDisk.partitions.filter((p) => p.id !== selectedPartition.id && !p.isSystem);
  }, [selectedDisk, selectedPartition]);
  const [mergeSourceId, setMergeSourceId] = useState<string>(siblingPartitions[0]?.id || '');

  const allocTargets = useMemo(() => {
    if (!selectedDisk || !selectedPartition) return [];
    return selectedDisk.partitions.filter((p) => p.id !== selectedPartition.id && p.fileSystem !== 'Unallocated');
  }, [selectedDisk, selectedPartition]);
  const [allocTargetId, setAllocTargetId] = useState<string>(allocTargets[0]?.id || '');
  const freeAllocAvailable = selectedPartition
    ? Math.max(0, Number((selectedPartition.sizeGB - selectedPartition.usedGB - 1).toFixed(1)))
    : 0;
  const [allocAmount, setAllocAmount] = useState<number>(Math.min(20, Math.max(1, freeAllocAvailable)));

  // Letter & Label
  const [newLetter, setNewLetter] = useState<string>(availableLetters[0] || '');
  const [newLabel, setNewLabel] = useState<string>(selectedPartition?.label || '');

  // Wipe
  const canWipePart = Boolean(selectedPartition && selectedPartition.fileSystem !== 'Unallocated' && !selectedPartition.isSystem);
  const canWipeDisk = Boolean(selectedDisk && !diskHasSystemPartition(selectedDisk));
  const [wipeTarget, setWipeTarget] = useState<'partition' | 'disk'>(canWipePart ? 'partition' : 'disk');
  const [wipeMethod, setWipeMethod] = useState<string>('Remplissage par zéros (1 passe - Rapide)');

  // Clone Disk (exclude system disk from targets)
  const [cloneSourceId, setCloneSourceId] = useState<string>(selectedDisk?.id || disks[0]?.id || '');
  const cloneTargetCandidates = useMemo(
    () => disks.filter((d) => d.id !== cloneSourceId && !diskHasSystemPartition(d)),
    [disks, cloneSourceId]
  );
  const [cloneTargetId, setCloneTargetId] = useState<string>(cloneTargetCandidates[0]?.id || '');
  const [cloneMode, setCloneMode] = useState<'quick' | 'sector'>('quick');
  const [cloneAlign4K, setCloneAlign4K] = useState<boolean>(true);
  const [cloneFit, setCloneFit] = useState<'proportional' | 'original'>('proportional');

  // Migrate OS
  const osDisk = useMemo(() => disks.find((d) => diskHasSystemPartition(d)), [disks]);
  const migrateCandidates = useMemo(
    () => disks.filter((d) => d.id !== osDisk?.id && !diskHasSystemPartition(d)),
    [disks, osDisk]
  );
  const [migrateTargetId, setMigrateTargetId] = useState<string>(migrateCandidates[0]?.id || '');
  const [migrateAlign4K, setMigrateAlign4K] = useState<boolean>(true);

  // Backup / Image state (wbadmin or VHDX)
  const [backupEngine, setBackupEngine] = useState<'wbadmin' | 'vhdx'>('wbadmin');
  const [backupSource, setBackupSource] = useState<string>('C:');
  const [backupTarget, setBackupTarget] = useState<string>('F:');
  const [backupVhdxPath, setBackupVhdxPath] = useState<string>('F:\\Backups\\FClonedisk-OS.vhdx');
  const [backupSizeGB, setBackupSizeGB] = useState<number>(120);

  // Surface Test
  const TOTAL_SECTORS = 192;
  const [scanningSurface, setScanningSurface] = useState(false);
  const [surfaceCells, setSurfaceCells] = useState<Array<'idle' | 'ok' | 'bad' | 'scanning'>>(() =>
    Array.from({ length: TOTAL_SECTORS }, () => 'idle')
  );

  // SMART & Benchmark
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResults, setBenchResults] = useState<{
    seqRead: number;
    seqWrite: number;
    rand4kRead: number;
    rand4kWrite: number;
  } | null>(null);

  // Recovery
  const [recoveryScanned, setRecoveryScanned] = useState(false);
  const [recoveryScanning, setRecoveryScanning] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState<'fast' | 'full'>('fast');

  // Bootable Media (dynamic USB drives from disks)
  const removableDrives = useMemo(() => disks.filter((d) => d.mediaType === 'Removable' || d.busType === 'USB'), [disks]);
  const [bootTarget, setBootTarget] = useState<string>(removableDrives[0] ? removableDrives[0].id : 'iso');
  const [bootProgress, setBootProgress] = useState<number>(0);
  const [bootBuilding, setBootBuilding] = useState<boolean>(false);
  const [bootDone, setBootDone] = useState<boolean>(false);

  // App Mover (dynamic destination drives from disks)
  const appDestDrives = useMemo(() => {
    const letters: Array<{ letter: string; label: string }> = [];
    for (const d of disks) {
      for (const p of d.partitions) {
        if (p.letter && p.letter !== 'C:' && p.fileSystem !== 'Unallocated') {
          letters.push({ letter: p.letter, label: p.label });
        }
      }
    }
    return letters;
  }, [disks]);
  const [selectedApps, setSelectedApps] = useState<string[]>(['app-2']);
  const [appTargetDrive, setAppTargetDrive] = useState<string>(appDestDrives[0]?.letter || '');

  // Apply Queue Execution
  const [applying, setApplying] = useState(false);
  const [applyPercent, setApplyPercent] = useState(0);
  const [applyDone, setApplyDone] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);
  const [applyLogs, setApplyLogs] = useState<string[]>([]);

  // Timers cleanup refs
  const timersRef = useRef<number[]>([]);
  const addTimer = (id: number) => timersRef.current.push(id);
  useEffect(() => {
    return () => {
      for (const id of timersRef.current) {
        window.clearTimeout(id);
        window.clearInterval(id);
      }
      timersRef.current = [];
    };
  }, []);

  // Keep cloneTargetId valid whenever cloneSourceId changes
  useEffect(() => {
    if (!cloneTargetCandidates.some((d) => d.id === cloneTargetId)) {
      setCloneTargetId(cloneTargetCandidates[0]?.id || '');
    }
  }, [cloneSourceId, cloneTargetCandidates, cloneTargetId]);

  // Escape key closes modal (when not actively applying)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applying, onClose]);

  // Surface test interval
  useEffect(() => {
    if (!scanningSurface) return;
    let idx = 0;
    const isWarnDisk = selectedDisk?.health === 'Avertissement';
    const timer = window.setInterval(() => {
      setSurfaceCells((prev) => {
        const next = [...prev];
        if (idx > 0 && idx <= TOTAL_SECTORS) {
          const isBad = isWarnDisk && (idx === 73 || idx === 142);
          next[idx - 1] = isBad ? 'bad' : 'ok';
        }
        if (idx < TOTAL_SECTORS) {
          next[idx] = 'scanning';
        }
        return next;
      });
      idx++;
      if (idx > TOTAL_SECTORS) {
        window.clearInterval(timer);
        setScanningSurface(false);
      }
    }, 24);
    return () => window.clearInterval(timer);
  }, [scanningSurface, selectedDisk]);

  // Bootable media interval (clean React effect)
  useEffect(() => {
    if (!bootBuilding) return;
    const iv = window.setInterval(() => {
      setBootProgress((p) => {
        if (p >= 100) {
          window.clearInterval(iv);
          return 100;
        }
        return Math.min(100, p + 17);
      });
    }, 220);
    return () => window.clearInterval(iv);
  }, [bootBuilding]);

  useEffect(() => {
    if (bootBuilding && bootProgress >= 100) {
      setBootBuilding(false);
      setBootDone(true);
    }
  }, [bootBuilding, bootProgress]);

  const startBenchmark = () => {
    setBenchRunning(true);
    setBenchResults(null);
    const isNvme = selectedDisk?.busType === 'NVMe';
    const isSataSsd = selectedDisk?.mediaType === 'SSD' && selectedDisk?.busType === 'SATA';
    const t = window.setTimeout(() => {
      setBenchResults({
        seqRead: isNvme ? 7180 : isSataSsd ? 554 : 186,
        seqWrite: isNvme ? 6640 : isSataSsd ? 512 : 172,
        rand4kRead: isNvme ? 88.4 : isSataSsd ? 41.2 : 1.4,
        rand4kWrite: isNvme ? 264.1 : isSataSsd ? 118.6 : 2.1,
      });
      setBenchRunning(false);
    }, 900);
    addTimer(t);
  };

  const runApplyQueue = async () => {
    setApplying(true);
    setApplyDone(false);
    setApplyFailed(false);
    setApplyPercent(0);
    setApplyLogs([
      `[F-Clonedisk Engine v1.0] Démarrage de ${pendingOps.length} opération(s)...`,
      `Mode actif : ${simulationMode ? 'Simulation sécurisée (Bac à sable)' : 'Windows Direct (PowerShell/Storage CIM)'}`,
    ]);

    if (!simulationMode && window.fClonedisk?.isElectron) {
      let unsub: (() => void) | null = null;
      try {
        unsub = window.fClonedisk.onProgress((prog: ExecutionProgressEvent) => {
          if (typeof prog.percent === 'number') setApplyPercent(prog.percent);
          if (prog.command) {
            setApplyLogs((prev) => [
              ...prev,
              `> ${prog.command}`,
              prog.error ? `ERREUR : ${prog.error}` : `Statut : ${prog.status}`,
            ]);
          }
        });
        const response = await window.fClonedisk.executeOperations(pendingOps);
        if (response.cancelled) {
          setApplyLogs((prev) => [...prev, '\nOpération annulée par l’utilisateur dans la confirmation Windows.']);
          setApplying(false);
          return;
        }
        const failed = response.results.filter((r) => !r.ok);
        if (failed.length > 0) {
          setApplyFailed(true);
          setApplyLogs((prev) => [
            ...prev,
            `\n✗ ${failed.length} opération(s) en échec. Les modifications n'ont pas toutes été appliquées.`,
          ]);
        } else {
          setApplyPercent(100);
          setApplyLogs((prev) => [...prev, '\n✓ Toutes les opérations Windows ont réussi.']);
        }
      } catch (err) {
        setApplyFailed(true);
        setApplyLogs((prev) => [...prev, `\n✗ ERREUR FATALE : ${(err as Error).message}`]);
      } finally {
        if (unsub) unsub();
        setApplying(false);
        setApplyDone(true);
      }
      return;
    }

    // Simulated execution
    for (let i = 0; i < pendingOps.length; i++) {
      const op = pendingOps[i];
      setApplyLogs((prev) => [...prev, `\n[${i + 1}/${pendingOps.length}] ${op.title}`, `  $ ${op.commandPreview}`]);
      await new Promise((r) => addTimer(window.setTimeout(r, 350)));
      setApplyPercent(Math.round(((i + 0.5) / pendingOps.length) * 100));
      await new Promise((r) => addTimer(window.setTimeout(r, 320)));
      setApplyLogs((prev) => [...prev, `  ✓ Terminé avec succès (4K vérifié, table des partitions synchronisée).`]);
      setApplyPercent(Math.round(((i + 1) / pendingOps.length) * 100));
    }

    setApplyLogs((prev) => [...prev, `\n✓ Toutes les opérations simulées ont été appliquées.`]);
    setApplying(false);
    setApplyDone(true);
  };

  const renderContent = () => {
    switch (modal) {
      case 'create':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title">
                <PlusCircle size={18} color="var(--accent)" /> Créer une partition — Create Anything
              </h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="info-banner">
                {simulationMode
                  ? 'Create Anything Engine : créez NTFS, FAT32 (> 32 Go), exFAT, EXT4/EXT3/EXT2, ReFS ou Linux Swap avec alignement 4K.'
                  : 'Mode Windows Natif : systèmes de fichiers supportés par Format-Volume (NTFS, FAT32 ≤ 32 Go, exFAT, ReFS).'}
              </div>
              <div className="form-field">
                <label>Taille de la partition : <span className="mono">{formatSize(createSize)}</span> / {formatSize(maxCreateGB)} disponibles</label>
                <input
                  type="range"
                  className="range-slider"
                  min={0.5}
                  max={Math.max(0.5, maxCreateGB)}
                  step={0.5}
                  value={createSize}
                  onChange={(e) => setCreateSize(Number(e.target.value))}
                />
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Taille exacte (Go)</label>
                  <input
                    type="number"
                    className="input mono"
                    min={0.5}
                    max={maxCreateGB}
                    step={0.5}
                    value={createSize}
                    onChange={(e) => setCreateSize(Math.min(maxCreateGB, Math.max(0.5, Number(e.target.value) || 0.5)))}
                  />
                </div>
                <div className="form-field">
                  <label>Système de fichiers</label>
                  <select className="select" value={createFs} onChange={(e) => setCreateFs(e.target.value as FileSystemType)}>
                    {fsChoices.map((fs) => (
                      <option key={fs} value={fs}>{fs}{fs === 'FAT32' && simulationMode ? ' (sans limite 32 Go)' : ''}</option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Lettre de lecteur</label>
                  <select
                    className="select"
                    value={createLetter}
                    disabled={createFs.startsWith('EXT') || createFs === 'LinuxSwap'}
                    onChange={(e) => setCreateLetter(e.target.value)}
                  >
                    <option value="">Aucune</option>
                    {availableLetters.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>Nom du volume (Label)</label>
                  <input className="input" value={createLabel} maxLength={32} onChange={(e) => setCreateLabel(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Taille de cluster</label>
                  <select className="select" value={createCluster} onChange={(e) => setCreateCluster(e.target.value)}>
                    {CLUSTERS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>Type de partition</label>
                  <select className="select" value={createRole} onChange={(e) => setCreateRole(e.target.value as PartitionRole)}>
                    <option value="Primary">Primaire</option>
                    <option value="Logical">Logique</option>
                  </select>
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={createAlign4K} onChange={(e) => setCreateAlign4K(e.target.checked)} />
                Activer l'alignement SSD 4K
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  props.onCreatePartition({
                    sizeGB: createSize,
                    fileSystem: createFs,
                    letter: createLetter,
                    label: createLabel,
                    clusterSize: createCluster,
                    role: createRole,
                    aligned4K: createAlign4K,
                  });
                  onClose();
                }}
              >
                Ajouter à la file d'attente
              </button>
            </div>
          </>
        );

      case 'resize':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Sliders size={18} color="var(--accent)" /> Redimensionner / Déplacer {selectedPartition?.letter || selectedPartition?.label}</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ background: 'var(--bg-surface)', padding: 12, borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 12 }}>
                  <span>Occupé : <strong className="mono">{formatSize(selectedPartition?.usedGB || 0)}</strong></span>
                  <span>Nouvelle taille : <strong className="mono" style={{ color: 'var(--accent)' }}>{formatSize(resizeSize)}</strong></span>
                  <span>Max extensible : <strong className="mono">{formatSize(maxExtendable)}</strong></span>
                </div>
                <div style={{ height: 28, background: 'var(--bg-input)', borderRadius: 6, overflow: 'hidden', display: 'flex', border: '1px solid var(--border-strong)' }}>
                  <div style={{ width: `${Math.min(100, (resizeSize / Math.max(0.5, maxExtendable)) * 100)}%`, background: 'var(--accent)', transition: 'width 0.1s' }}>
                    <div style={{ width: `${Math.min(100, ((selectedPartition?.usedGB || 0) / Math.max(0.5, resizeSize)) * 100)}%`, height: '100%', background: 'rgba(255,255,255,0.28)' }} />
                  </div>
                </div>
              </div>
              {minShrinkable >= maxExtendable ? (
                <div className="warn-banner">Cette partition ne dispose pas de marge suffisante pour être redimensionnée.</div>
              ) : (
                <>
                  <div className="form-field">
                    <label>Ajuster la taille ({formatSize(minShrinkable)} à {formatSize(maxExtendable)})</label>
                    <input
                      type="range"
                      className="range-slider"
                      min={minShrinkable}
                      max={maxExtendable}
                      step={0.5}
                      value={resizeSize}
                      onChange={(e) => setResizeSize(Number(e.target.value))}
                    />
                  </div>
                  <div className="form-grid">
                    <div className="form-field">
                      <label>Taille exacte (Go)</label>
                      <input
                        type="number"
                        className="input mono"
                        min={minShrinkable}
                        max={maxExtendable}
                        step={0.5}
                        value={resizeSize}
                        onChange={(e) => setResizeSize(Math.min(maxExtendable, Math.max(minShrinkable, Number(e.target.value) || minShrinkable)))}
                      />
                    </div>
                    <div className="form-field">
                      <label>Espace non alloué résultant</label>
                      <input className="input mono" disabled value={formatSize(Math.max(0, maxExtendable - resizeSize))} />
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={minShrinkable >= maxExtendable}
                onClick={() => {
                  props.onResizePartition(resizeSize);
                  onClose();
                }}
              >
                Valider le redimensionnement
              </button>
            </div>
          </>
        );

      case 'format':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Eraser size={18} color="var(--warning)" /> Formater {selectedPartition?.letter || selectedPartition?.label}</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="warn-banner">
                Attention : le formatage effacera toutes les données présentes sur cette partition lors de l'application.
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Système de fichiers</label>
                  <select className="select" value={fmtFs} onChange={(e) => setFmtFs(e.target.value as FileSystemType)}>
                    {fsChoices.map((fs) => <option key={fs} value={fs}>{fs}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>Nom du volume</label>
                  <input className="input" value={fmtLabel} maxLength={32} onChange={(e) => setFmtLabel(e.target.value)} />
                </div>
                <div className="form-field">
                  <label>Taille de cluster</label>
                  <select className="select" value={fmtCluster} onChange={(e) => setFmtCluster(e.target.value)}>
                    {CLUSTERS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={fmtQuick} onChange={(e) => setFmtQuick(e.target.checked)} />
                Formatage rapide
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  props.onFormatPartition({ fileSystem: fmtFs, label: fmtLabel, clusterSize: fmtCluster, quick: fmtQuick });
                  onClose();
                }}
              >
                Planifier le formatage
              </button>
            </div>
          </>
        );

      case 'split':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Scissors size={18} color="var(--accent)" /> Diviser la partition {selectedPartition?.letter || selectedPartition?.label}</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {maxSplit < 1 ? (
                <div className="warn-banner">Espace libre insuffisant pour diviser cette partition (au moins 1 Go libre + marge requis).</div>
              ) : (
                <>
                  <div className="form-field">
                    <label>Taille de la nouvelle partition : <strong className="mono">{formatSize(splitSize)}</strong> (Max : {formatSize(maxSplit)})</label>
                    <input
                      type="range"
                      className="range-slider"
                      min={1}
                      max={maxSplit}
                      step={0.5}
                      value={splitSize}
                      onChange={(e) => setSplitSize(Number(e.target.value))}
                    />
                  </div>
                  <div className="form-grid">
                    <div className="form-field">
                      <label>Nouvelle lettre</label>
                      <select className="select" value={splitLetter} onChange={(e) => setSplitLetter(e.target.value)}>
                        <option value="">Aucune</option>
                        {availableLetters.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                    <div className="form-field">
                      <label>Nom de la nouvelle partition</label>
                      <input className="input" value={splitLabel} maxLength={32} onChange={(e) => setSplitLabel(e.target.value)} />
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={maxSplit < 1}
                onClick={() => {
                  props.onSplitPartition(splitSize, splitLetter, splitLabel);
                  onClose();
                }}
              >
                Diviser la partition
              </button>
            </div>
          </>
        );

      case 'merge':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Layers size={18} color="var(--accent)" /> Fusionner dans {selectedPartition?.letter || selectedPartition?.label}</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {siblingPartitions.length === 0 ? (
                <div className="warn-banner">Aucune autre partition non-système disponible sur ce disque pour la fusion.</div>
              ) : (
                <>
                  <div className="form-field">
                    <label>Sélectionner la partition ou l'espace non alloué à fusionner</label>
                    <select className="select" value={mergeSourceId} onChange={(e) => setMergeSourceId(e.target.value)}>
                      {siblingPartitions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.letter || '(Sans lettre)'} {p.label} — {p.fileSystem} ({formatSize(p.sizeGB)})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="info-banner">
                    Les fichiers de la partition source seront regroupés sans perte de données.
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={!mergeSourceId}
                onClick={() => {
                  props.onMergePartition(mergeSourceId);
                  onClose();
                }}
              >
                Fusionner
              </button>
            </div>
          </>
        );

      case 'allocate':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Sparkles size={18} color="var(--accent)" /> Allouer de l'espace libre depuis {selectedPartition?.letter || selectedPartition?.label}</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {freeAllocAvailable < 1 || allocTargets.length === 0 ? (
                <div className="warn-banner">Espace libre insuffisant ou aucune partition cible disponible sur ce disque.</div>
              ) : (
                <div className="form-grid">
                  <div className="form-field">
                    <label>Quantité à transférer (Max {formatSize(freeAllocAvailable)})</label>
                    <input
                      type="number"
                      className="input mono"
                      min={1}
                      max={freeAllocAvailable}
                      value={allocAmount}
                      onChange={(e) => setAllocAmount(Math.min(freeAllocAvailable, Math.max(1, Number(e.target.value) || 1)))}
                    />
                  </div>
                  <div className="form-field">
                    <label>Vers la partition cible</label>
                    <select className="select" value={allocTargetId} onChange={(e) => setAllocTargetId(e.target.value)}>
                      {allocTargets.map((p) => (
                        <option key={p.id} value={p.id}>{p.letter || p.label} ({formatSize(p.sizeGB)})</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={!allocTargetId || freeAllocAvailable < 1}
                onClick={() => {
                  props.onAllocateSpace(allocTargetId, allocAmount);
                  onClose();
                }}
              >
                Allouer l'espace
              </button>
            </div>
          </>
        );

      case 'letter':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Tag size={18} color="var(--accent)" /> Changer la lettre de lecteur</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label>Nouvelle lettre pour {selectedPartition?.label}</label>
                <select className="select" value={newLetter} onChange={(e) => setNewLetter(e.target.value)}>
                  <option value="">Aucune (Retirer la lettre)</option>
                  {availableLetters.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button className="btn btn-primary" onClick={() => { props.onChangeLetter(newLetter); onClose(); }}>Appliquer</button>
            </div>
          </>
        );

      case 'label':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Tag size={18} color="var(--accent)" /> Renommer le volume (Label)</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="form-field">
                <label>Nouveau nom de volume</label>
                <input className="input" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={32} />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button className="btn btn-primary" onClick={() => { props.onChangeLabel(newLabel); onClose(); }}>Renommer</button>
            </div>
          </>
        );

      case 'wipe':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><ShieldAlert size={18} color="var(--danger)" /> Effacement sécurisé (Wipe / SSD Secure Erase)</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {!canWipePart && !canWipeDisk ? (
                <div className="warn-banner">
                  <strong>Protection système active :</strong> impossible d'effacer un disque ou une partition contenant Windows / EFI.
                </div>
              ) : (
                <>
                  <div className="warn-banner">
                    <strong>Destruction irréversible :</strong> les données effacées ne pourront plus être récupérées.
                  </div>
                  <div className="form-grid">
                    <div className="form-field">
                      <label>Cible</label>
                      <select className="select" value={wipeTarget} onChange={(e) => setWipeTarget(e.target.value as 'partition' | 'disk')}>
                        {canWipePart && (
                          <option value="partition">Partition {selectedPartition?.letter || selectedPartition?.label}</option>
                        )}
                        {canWipeDisk && (
                          <option value="disk">Disque entier : Disque {selectedDisk?.number} ({selectedDisk?.model})</option>
                        )}
                      </select>
                    </div>
                    <div className="form-field">
                      <label>Algorithme d'effacement (FClonedisk.DiskWorker.exe)</label>
                      <select className="select" value={wipeMethod} onChange={(e) => setWipeMethod(e.target.value)}>
                        <option>Remplissage par zéros (1 passe - Rapide)</option>
                        <option>Données aléatoires (1 passe)</option>
                        <option>DoD 5220.22-M (3 passes - Militaire US)</option>
                        <option>DoD 5220.22-ECE (7 passes)</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-danger"
                disabled={!canWipePart && !canWipeDisk}
                onClick={() => {
                  props.onWipe(wipeTarget, wipeMethod);
                  onClose();
                }}
              >
                <Trash2 size={14} /> Planifier l'effacement
              </button>
            </div>
          </>
        );

      case 'backup':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><HardDrive size={18} color="var(--accent)" /> Sauvegarde système (wbadmin) ou copie de fichiers (VHDX)</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="info-banner">
                Créez une sauvegarde système Windows restaurable (<code>wbadmin</code>), ou une simple <strong>copie de fichiers</strong> dans un disque virtuel VHDX. La copie VHDX ne permet pas de restaurer un Windows démarrable.
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Moteur de sauvegarde</label>
                  <select className="select" value={backupEngine} onChange={(e) => setBackupEngine(e.target.value as 'wbadmin' | 'vhdx')}>
                    <option value="wbadmin">Windows Server Backup (wbadmin -allCritical)</option>
                    <option value="vhdx">Copie de fichiers vers un VHDX (robocopy, non démarrable)</option>
                  </select>
                </div>
                <div className="form-field">
                  <label>Volume source</label>
                  <select className="select" value={backupSource} onChange={(e) => setBackupSource(e.target.value)}>
                    <option value="C:">C: Système</option>
                    {appDestDrives.map((d) => (
                      <option key={d.letter} value={d.letter}>{d.letter} {d.label}</option>
                    ))}
                  </select>
                </div>
                {backupEngine === 'wbadmin' ? (
                  <div className="form-field">
                    <label>Lecteur de destination</label>
                    <select className="select" value={backupTarget} onChange={(e) => setBackupTarget(e.target.value)}>
                      {appDestDrives.filter((d) => d.letter !== backupSource).map((d) => (
                        <option key={d.letter} value={d.letter}>{d.letter} {d.label}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <>
                    <div className="form-field">
                      <label>Fichier image (.vhdx)</label>
                      <input className="input mono" value={backupVhdxPath} onChange={(e) => setBackupVhdxPath(e.target.value)} />
                    </div>
                    <div className="form-field">
                      <label>Taille maximale dynamique (Go)</label>
                      <input type="number" className="input mono" min={10} max={4096} value={backupSizeGB} onChange={(e) => setBackupSizeGB(Math.max(10, Number(e.target.value) || 64))} />
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  props.onBackup({
                    engine: backupEngine,
                    sourceDrive: backupSource,
                    targetDrive: backupTarget,
                    vhdxPath: backupVhdxPath,
                    sizeGB: backupSizeGB,
                  });
                  onClose();
                }}
              >
                Planifier la sauvegarde
              </button>
            </div>
          </>
        );

      case 'clone_disk':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Copy size={18} color="var(--accent)" /> Assistant F-Clonedisk — Cloner un disque</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="info-banner">
                Exécuté via le processus séparé <code>FClonedisk.DiskWorker.exe</code> (lecture/écriture brute alignée 4 Mo sur <code>\\.\PhysicalDriveN</code>).
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>1. Disque Source</label>
                  <select className="select" value={cloneSourceId} onChange={(e) => setCloneSourceId(e.target.value)}>
                    {disks.map((d) => (
                      <option key={d.id} value={d.id}>Disque {d.number} — {d.model} ({formatSize(d.sizeGB)})</option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>2. Disque Cible (non-système, sera écrasé)</label>
                  <select className="select" value={cloneTargetId} onChange={(e) => setCloneTargetId(e.target.value)}>
                    {cloneTargetCandidates.map((d) => (
                      <option key={d.id} value={d.id}>Disque {d.number} — {d.model} ({formatSize(d.sizeGB)})</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-grid">
                <div className="form-field">
                  <label>Méthode de clonage</label>
                  <select className="select" value={cloneMode} onChange={(e) => setCloneMode(e.target.value as 'quick' | 'sector')}>
                    <option value="quick">Cloner rapidement (secteurs utilisés uniquement)</option>
                    <option value="sector">Cloner secteur par secteur (copie brute intégrale)</option>
                  </select>
                </div>
                <div className="form-field">
                  <label>Ajustement des partitions sur la cible</label>
                  <select className="select" value={cloneFit} onChange={(e) => setCloneFit(e.target.value as 'proportional' | 'original')}>
                    <option value="proportional">Adapter automatiquement à tout le disque cible</option>
                    <option value="original">Conserver la taille d'origine des partitions</option>
                  </select>
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={cloneAlign4K} onChange={(e) => setCloneAlign4K(e.target.checked)} />
                Optimiser les performances du SSD cible (Alignement 4K)
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={!cloneSourceId || !cloneTargetId || cloneSourceId === cloneTargetId}
                onClick={() => {
                  props.onCloneDisk(cloneSourceId, cloneTargetId, { mode: cloneMode, align4K: cloneAlign4K, fitMode: cloneFit });
                  onClose();
                }}
              >
                Planifier le clonage
              </button>
            </div>
          </>
        );

      case 'migrate_os':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Cpu size={18} color="var(--accent)" /> Migrer l'OS vers un SSD / HDD</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="info-banner">
                Système détecté : <strong>Disque {osDisk?.number ?? '—'} ({osDisk?.model ?? 'Aucun'})</strong> — Partitions EFI + Windows + WinRE Recovery seront migrées avec réparation UEFI BCD.
              </div>
              <div className="form-field">
                <label>Disque de destination (non-système)</label>
                <select className="select" value={migrateTargetId} onChange={(e) => setMigrateTargetId(e.target.value)}>
                  {migrateCandidates.map((d) => (
                    <option key={d.id} value={d.id}>Disque {d.number} — {d.model} ({formatSize(d.sizeGB)})</option>
                  ))}
                </select>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={migrateAlign4K} onChange={(e) => setMigrateAlign4K(e.target.checked)} />
                Alignement 4K SSD + réparation du chargeur d'amorçage UEFI
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={!migrateTargetId || !osDisk}
                onClick={() => {
                  props.onMigrateOs(migrateTargetId, migrateAlign4K);
                  onClose();
                }}
              >
                Planifier la migration OS
              </button>
            </div>
          </>
        );

      case 'surface_test': {
        const okCount = surfaceCells.filter((c) => c === 'ok').length;
        const badCount = surfaceCells.filter((c) => c === 'bad').length;
        const pct = Math.round(((okCount + badCount) / TOTAL_SECTORS) * 100);
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Activity size={18} color="var(--accent)" /> Test de surface — Disque {selectedDisk?.number} ({selectedDisk?.model})</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                <span>Progression : <strong className="mono">{pct}%</strong></span>
                <span style={{ color: 'var(--success)' }}>Sains : <strong className="mono">{okCount}</strong></span>
                <span style={{ color: 'var(--danger)' }}>Défectueux : <strong className="mono">{badCount}</strong></span>
              </div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${pct}%` }} /></div>
              <div className="sector-grid">
                {surfaceCells.map((state, i) => <div key={i} className={`sector-cell ${state}`} />)}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Fermer</button>
              <button
                className="btn btn-primary"
                disabled={scanningSurface}
                onClick={() => {
                  setSurfaceCells(Array.from({ length: TOTAL_SECTORS }, () => 'idle'));
                  setScanningSurface(true);
                }}
              >
                <Play size={14} /> {scanningSurface ? 'Analyse en cours...' : 'Démarrer le test'}
              </button>
            </div>
          </>
        );
      }

      case 'smart_bench': {
        const sm = selectedDisk?.smart;
        const fmtVal = (v: number | null | undefined, suffix: string) => (v === null || v === undefined ? 'N/A' : `${v} ${suffix}`.trim());
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Gauge size={18} color="var(--accent)" /> Santé S.M.A.R.T. & Benchmark — Disque {selectedDisk?.number}</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="kpi-row">
                <div className="kpi-card">
                  <div className="kpi-label">Santé Globale</div>
                  <div className="kpi-value mono" style={{ color: (sm?.healthPercent || 0) > 90 ? 'var(--success)' : 'var(--warning)' }}>
                    {sm ? `${sm.healthPercent}%` : 'N/A'}
                  </div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Température</div>
                  <div className="kpi-value mono">{fmtVal(sm?.temperatureC, '°C')}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Total écrit (TBW)</div>
                  <div className="kpi-value mono">{fmtVal(sm?.totalWrittenTB, 'To')}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Heures allumé</div>
                  <div className="kpi-value mono">{fmtVal(sm?.powerOnHours, 'h')}</div>
                </div>
              </div>

              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <strong>Benchmark de vitesse (Lecture / Écriture)</strong>
                  <button className="btn btn-primary" disabled={benchRunning} onClick={startBenchmark}>
                    <Play size={13} /> {benchRunning ? 'Mesure...' : 'Lancer Benchmark'}
                  </button>
                </div>
                {benchResults ? (
                  <div className="form-grid">
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Lecture séquentielle</div>
                      <div className="mono" style={{ fontSize: 17, fontWeight: 700, color: 'var(--accent)' }}>{benchResults.seqRead} Mo/s</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Écriture séquentielle</div>
                      <div className="mono" style={{ fontSize: 17, fontWeight: 700, color: 'var(--success)' }}>{benchResults.seqWrite} Mo/s</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Lecture aléatoire 4K</div>
                      <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{benchResults.rand4kRead} Mo/s</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Écriture aléatoire 4K</div>
                      <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{benchResults.rand4kWrite} Mo/s</div>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    Cliquez sur « Lancer Benchmark » pour mesurer les débits séquentiels et 4K aléatoires de {selectedDisk?.model}.
                  </div>
                )}
              </div>

              <table className="part-table" style={{ border: '1px solid var(--border-subtle)' }}>
                <thead>
                  <tr><th>Attribut S.M.A.R.T.</th><th>Valeur</th><th>Statut</th></tr>
                </thead>
                <tbody>
                  <tr><td>Secteurs réalloués</td><td className="mono">{sm?.reallocatedSectors ?? 'N/A'}</td><td>{sm?.reallocatedSectors === 0 ? 'OK' : 'Avertissement'}</td></tr>
                  <tr><td>Secteurs en attente</td><td className="mono">{sm?.pendingSectors ?? 'N/A'}</td><td>{sm?.pendingSectors === 0 ? 'OK' : 'Avertissement'}</td></tr>
                  <tr><td>Cycles d'alimentation</td><td className="mono">{fmtVal(sm?.powerCycles, '')}</td><td>OK</td></tr>
                  <tr><td>Niveau d'usure NAND</td><td className="mono">{fmtVal(sm?.wearLevelPercent, '%')}</td><td>OK</td></tr>
                  <tr><td>Arrêts non sécurisés</td><td className="mono">{sm?.unsafeShutdowns ?? 'N/A'}</td><td>OK</td></tr>
                </tbody>
              </table>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={onClose}>Fermer</button>
            </div>
          </>
        );
      }

      case 'recovery':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Search size={18} color="var(--accent)" /> Assistant Récupération de Partitions</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <select className="select" value={recoveryMode} onChange={(e) => setRecoveryMode(e.target.value as 'fast' | 'full')}>
                  <option value="fast">Recherche rapide (recommandé)</option>
                  <option value="full">Recherche complète secteur par secteur</option>
                </select>
                <button
                  className="btn btn-primary"
                  disabled={recoveryScanning}
                  onClick={() => {
                    setRecoveryScanning(true);
                    addTimer(
                      window.setTimeout(() => {
                        setRecoveryScanning(false);
                        setRecoveryScanned(true);
                      }, 750)
                    );
                  }}
                >
                  {recoveryScanning ? 'Analyse...' : 'Rechercher'}
                </button>
              </div>
              {recoveryScanned && (
                <table className="part-table" style={{ border: '1px solid var(--border-subtle)' }}>
                  <thead>
                    <tr><th>Disque</th><th>Volume perdu</th><th>FS</th><th>Taille</th><th>Fichiers</th><th>Intégrité</th><th>Action</th></tr>
                  </thead>
                  <tbody>
                    {MOCK_RECOVERABLE_PARTITIONS.map((rec) => (
                      <tr key={rec.id}>
                        <td className="mono">Disque {rec.diskNumber}</td>
                        <td><strong>{rec.label}</strong></td>
                        <td>{rec.fileSystem}</td>
                        <td className="mono">{formatSize(rec.sizeGB)}</td>
                        <td className="mono">{rec.filesCount.toLocaleString('fr-FR')}</td>
                        <td style={{ color: 'var(--success)' }}>{rec.integrity}</td>
                        <td>
                          <button
                            className="btn btn-success"
                            style={{ padding: '3px 8px', fontSize: 11.5 }}
                            onClick={() => {
                              props.onRecoverPartition(rec);
                              onClose();
                            }}
                          >
                            Restaurer
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Fermer</button>
            </div>
          </>
        );

      case 'bootable_media':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Disc size={18} color="var(--accent)" /> Créateur de média bootable WinPE (F-Clonedisk)</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="info-banner">
                Créez une clé USB ou image ISO Windows PE bootable UEFI/Legacy intégrant F-Clonedisk.
              </div>
              <div className="form-field">
                <label>Support de destination</label>
                <select className="select" value={bootTarget} onChange={(e) => setBootTarget(e.target.value)}>
                  {removableDrives.map((d) => (
                    <option key={d.id} value={d.id}>
                      Clé USB — Disque {d.number} : {d.model} ({formatSize(d.sizeGB)})
                    </option>
                  ))}
                  <option value="iso">Exporter un fichier image ISO (F-Clonedisk-WinPE-x64.iso)</option>
                </select>
              </div>
              {(bootBuilding || bootDone) && (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                    <span>{bootDone ? 'Média bootable WinPE prêt !' : 'Injection des pilotes NVMe/RAID et noyau WinPE...'}</span>
                    <span className="mono">{bootProgress}%</span>
                  </div>
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${bootProgress}%` }} /></div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Fermer</button>
              <button
                className="btn btn-primary"
                disabled={bootBuilding}
                onClick={() => {
                  setBootDone(false);
                  setBootProgress(15);
                  setBootBuilding(true);
                }}
              >
                Créer le média WinPE
              </button>
            </div>
          </>
        );

      case 'app_mover': {
        const totalSelectedGB = MOCK_MOVABLE_APPS.filter((a) => selectedApps.includes(a.id)).reduce((s, a) => s + a.sizeGB, 0);
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><FolderSync size={18} color="var(--accent)" /> App Mover — Déplacer les applications de C:</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <div className="info-banner">
                Libérez de l'espace sur le disque système <strong>C:</strong> en déplaçant des logiciels lourds vers un autre lecteur (jonctions NTFS).
              </div>
              <table className="part-table" style={{ border: '1px solid var(--border-subtle)' }}>
                <thead>
                  <tr><th style={{ width: 32 }}></th><th>Application</th><th>Éditeur</th><th>Taille</th></tr>
                </thead>
                <tbody>
                  {MOCK_MOVABLE_APPS.map((app) => {
                    const checked = selectedApps.includes(app.id);
                    return (
                      <tr key={app.id} onClick={() => setSelectedApps((prev) => (checked ? prev.filter((x) => x !== app.id) : [...prev, app.id]))}>
                        <td><input type="checkbox" checked={checked} readOnly /></td>
                        <td><strong>{app.name}</strong><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{app.path}</div></td>
                        <td>{app.publisher}</td>
                        <td className="mono">{formatSize(app.sizeGB)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="form-grid">
                <div className="form-field">
                  <label>Lecteur de destination</label>
                  <select className="select" value={appTargetDrive} onChange={(e) => setAppTargetDrive(e.target.value)}>
                    {appDestDrives.map((d) => (
                      <option key={d.letter} value={d.letter}>{d.letter} {d.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-field">
                  <label>Espace qui sera libéré sur C:</label>
                  <input className="input mono" disabled value={formatSize(totalSelectedGB)} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={selectedApps.length === 0 || !appTargetDrive}
                onClick={() => {
                  props.onMoveApps(selectedApps, appTargetDrive);
                  onClose();
                }}
              >
                Déplacer ({formatSize(totalSelectedGB)})
              </button>
            </div>
          </>
        );
      }

      case 'properties':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Info size={18} color="var(--accent)" /> Propriétés détaillées</h2>
              <button className="btn btn-ghost" aria-label="Fermer" onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {selectedPartition ? (
                <table className="part-table" style={{ border: '1px solid var(--border-subtle)' }}>
                  <tbody>
                    <tr><td><strong>Volume</strong></td><td>{selectedPartition.letter || '(Sans lettre)'} — {selectedPartition.label}</td></tr>
                    <tr><td><strong>Système de fichiers</strong></td><td>{selectedPartition.fileSystem}</td></tr>
                    <tr><td><strong>Capacité totale</strong></td><td className="mono">{formatSize(selectedPartition.sizeGB)}</td></tr>
                    <tr><td><strong>Espace utilisé</strong></td><td className="mono">{formatSize(selectedPartition.usedGB)}</td></tr>
                    <tr><td><strong>Espace libre</strong></td><td className="mono">{formatSize(Math.max(0, selectedPartition.sizeGB - selectedPartition.usedGB))}</td></tr>
                    <tr><td><strong>Rôle</strong></td><td>{selectedPartition.role}</td></tr>
                    <tr><td><strong>Taille de cluster</strong></td><td className="mono">{selectedPartition.clusterSize}</td></tr>
                    <tr><td><strong>Alignement SSD 4K</strong></td><td style={{ color: selectedPartition.aligned4K ? 'var(--success)' : 'var(--warning)' }}>{selectedPartition.aligned4K ? 'Aligné (Optimal)' : 'Non aligné'}</td></tr>
                  </tbody>
                </table>
              ) : (
                <table className="part-table" style={{ border: '1px solid var(--border-subtle)' }}>
                  <tbody>
                    <tr><td><strong>Modèle</strong></td><td>{selectedDisk?.model}</td></tr>
                    <tr><td><strong>Numéro de série</strong></td><td className="mono">{selectedDisk?.serial}</td></tr>
                    <tr><td><strong>Interface / Type</strong></td><td>{selectedDisk?.busType} / {selectedDisk?.mediaType}</td></tr>
                    <tr><td><strong>Table de partitions</strong></td><td>{selectedDisk?.partitionStyle}</td></tr>
                    <tr><td><strong>Capacité</strong></td><td className="mono">{formatSize(selectedDisk?.sizeGB || 0)}</td></tr>
                    <tr><td><strong>Santé S.M.A.R.T.</strong></td><td>{selectedDisk?.health} ({selectedDisk?.smart.healthPercent}%)</td></tr>
                  </tbody>
                </table>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={onClose}>Fermer</button>
            </div>
          </>
        );

      case 'apply':
        return (
          <>
            <div className="modal-header">
              <h2 className="modal-title"><Terminal size={18} color="var(--success)" /> Appliquer les opérations en attente ({pendingOps.length})</h2>
              <button className="btn btn-ghost" aria-label="Fermer" disabled={applying} onClick={onClose}><X size={16} /></button>
            </div>
            <div className="modal-body">
              {!applying && !applyDone && (
                <>
                  <div className={simulationMode ? 'info-banner' : 'warn-banner'}>
                    {simulationMode
                      ? 'Mode Simulation actif : les opérations seront exécutées sur la topologie virtuelle sans toucher à vos disques physiques.'
                      : 'Mode Windows Réel actif : une boîte de confirmation Administrateur native vous sera demandée avant toute écriture sur vos disques physiques.'}
                  </div>
                  {pendingOps.some((op) => op.type === 'convert_gpt') && (
                    <div className="warn-banner">
                      <strong>Important (MBR → GPT) :</strong> passez le BIOS en mode <strong>UEFI</strong> avant de redémarrer Windows (validation <code>mbr2gpt /validate</code> exécutée automatiquement avant <code>/convert</code>).
                    </div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                    {pendingOps.map((op, i) => (
                      <div key={op.id} style={{ padding: '8px 10px', borderRadius: 6, background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}>
                        <div style={{ fontWeight: 600 }}>{i + 1}. {op.title}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{op.description}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{op.commandPreview}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {(applying || applyDone) && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                      {applyFailed ? (
                        <XCircle size={16} color="var(--danger)" />
                      ) : applyDone ? (
                        <CheckCircle2 size={16} color="var(--success)" />
                      ) : (
                        <HardDrive size={16} color="var(--accent)" />
                      )}
                      {applyFailed
                        ? 'Exécution interrompue suite à une erreur'
                        : applyDone
                          ? 'Opérations terminées avec succès !'
                          : 'Exécution en cours...'}
                    </span>
                    <span className="mono">{applyPercent}%</span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${applyPercent}%`,
                        background: applyFailed ? 'var(--danger)' : applyDone ? 'var(--success)' : 'var(--accent)',
                      }}
                    />
                  </div>
                  <div className="terminal-log">{applyLogs.join('\n')}</div>
                </>
              )}
            </div>
            <div className="modal-footer">
              {!applying && !applyDone && (
                <>
                  <button className="btn" onClick={onClose}>Annuler</button>
                  <button className="btn btn-success" onClick={runApplyQueue}>
                    <Play size={14} /> Exécuter maintenant
                  </button>
                </>
              )}
              {applyDone && (
                <>
                  {window.fClonedisk?.exportLog && (
                    <button className="btn" onClick={() => window.fClonedisk?.exportLog(applyLogs.join('\n'))}>
                      Exporter le journal
                    </button>
                  )}
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      props.onApplyFinished(!applyFailed);
                      onClose();
                    }}
                  >
                    {applyFailed ? 'Fermer' : 'Terminer'}
                  </button>
                </>
              )}
            </div>
          </>
        );
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !applying) onClose();
      }}
    >
      <div className={`modal-card ${['smart_bench', 'recovery', 'app_mover', 'apply', 'surface_test'].includes(modal) ? 'wide' : ''}`}>
        {renderContent()}
      </div>
    </div>
  );
};
