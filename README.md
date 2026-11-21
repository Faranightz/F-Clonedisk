# F-Clonedisk — Gestionnaire de Partitions & Clonage de Disques

**F-Clonedisk** est une application desktop Windows (Electron + React + TypeScript) inspirée d'AOMEI Partition Assistant Pro, intégrant le moteur **Create Anything**, le clonage de disque/OS, les diagnostics S.M.A.R.T. & Benchmark, le test de surface et une file d'attente d'opérations avec prévisualisation en temps réel.

## Fonctionnalités principales
- **Create Anything** : création universelle de partitions (`NTFS`, `FAT32` sans limite 32 Go, `exFAT`, `EXT4`, `EXT3`, `EXT2`, `ReFS`, `Linux Swap`) avec taille de cluster et alignement SSD 4K.
- **Clonage & Migration** : Assistant Clonage de Disque (rapide ou secteur par secteur + alignement 4K), Migration de l'OS (EFI + Windows + WinRE + réparation BCD UEFI).
- **Gestion complète des partitions** : Redimensionner/Déplacer avec curseur visuel, Fusionner, Diviser, Allouer de l'espace libre, Formater, Changer lettre/label, Convertir `MBR ↔ GPT` et `NTFS ↔ FAT32`, Masquer/Afficher, Vérifier (`chkdsk`), Reconstruire le MBR.
- **Boîte à outils avancée** : Santé **S.M.A.R.T.** & **Benchmark** séquentiel/4K, **Test de surface** visuel des secteurs, **Récupération de partitions perdues**, **Créateur de média bootable WinPE (USB/ISO)**, **App Mover** et **Effacement sécurisé (DoD 5220.22-M / Gutmann / SSD Secure Erase)**.
- **Double mode** : **Mode Windows Réel** (PowerShell CIM / Storage / `mbr2gpt` / `chkdsk` en Administrateur) et **Mode Simulation** sécurisé pour tester toutes les opérations sans risque.

## Compiler pour Windows (`.exe`)

```bash
npm install
npm run build:win
```

Les exécutables Windows (`F-Clonedisk Setup.exe` NSIS x64 + version portable x64 avec élévation Administrateur) sont générés dans `release/`.

Pour lancer en développement :

```bash
npm run electron:dev
```
