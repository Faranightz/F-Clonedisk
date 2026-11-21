# HANDOFF — F-Clonedisk

Rédigé par Claude Code le 21/11/2026. Repris par : **Antigravity (`agy`)**.

## Objectif

Farid veut un **vrai équivalent d'AOMEI Partition Assistant / AOMEI Backupper**, pour son **usage personnel uniquement**.
L'app ne sera **ni vendue, ni distribuée**.

Concrètement : toutes les fonctions qui sont aujourd'hui **simulées** doivent marcher **pour de vrai** sur des disques Windows, en sécurité.

Cadre à respecter (même en usage perso) :
- On reproduit les **fonctions** et le **parcours** d'AOMEI : vue des disques, file d'opérations, bouton « Appliquer », assistants. C'est autorisé.
- On ne copie **pas** le code, les binaires, les logos, les icônes ni le nom d'AOMEI. On ne décompile pas AOMEI. Le nom reste « F-Clonedisk ».
- Interface aux couleurs de la charte Rapide iT (skill `charte-rapide-it`) : bleu #1746D1, rose #E83E8C pour les accents seulement, bleu nuit #10213A, gris #F5F7FC. Manrope pour les titres, Inter pour le texte, polices auto-hébergées.

## Fait (avec preuves)

- Audit complet du commit `fb33033` : https://claude.ai/artifact/9atjvrrCxqx285TgSDpqca
- `npm install` + `npm run build` : OK (1 633 modules).
- `npm test` : 4/4 réussis.
- `npm audit --omit=dev` : 0 faille. `npm audit` complet : 8 failles (2 hautes, Electron 35).
- Aucune opération n'a été lancée sur un vrai disque.
- Aucun fichier du dépôt n'a été modifié, sauf ce `HANDOFF.md` (non commité).

## Reste à faire

### Étape 1 — Sécurité d'abord (obligatoire avant toute nouvelle fonction réelle)

1. **Numéros de partition** (`src/utils/diskEngine.ts:31`, `normalizePartitions`) : ne plus renuméroter par position. Garder le vrai `PartitionNumber` Windows. Une partition créée dans la file n'a pas encore de numéro : bloquer les autres opérations sur elle, ou relire les disques entre deux opérations.
2. **Identité du disque** : envoyer `SerialNumber`/`UniqueId` et la taille avec chaque opération. Le backend (`electron/diskBackend.cjs`) vérifie juste avant d'exécuter. S'il y a un écart, il bloque tout.
3. **Valider toute la file avant d'exécuter** (`diskBackend.cjs:398`) : construire toutes les commandes d'abord. Si une seule est invalide, ne rien exécuter.
4. **Confirmation** (`electron/main.cjs:85`) : afficher les vraies commandes, le modèle et le n° de série du disque. Ne plus afficher `op.title`.
5. **Formatage et retrait de lettre** : retrouver la partition par sa lettre (`Get-Partition -DriveLetter`), refuser si IsSystem/IsBoot, et vérifier qu'elle est bien sur le disque annoncé.
6. **Noms de volume** (`sanitizeVolumeLabel`) : doubler aussi les guillemets `‘ ’ ‚ ›` (`/['‘’‚‛]/g`), ou n'autoriser que lettres, chiffres, espace et tiret.
7. **MBR → GPT** : lancer `mbr2gpt /validate` avant `/convert`. Afficher « passez le BIOS en UEFI avant de redémarrer ».
8. Mettre à jour Electron et electron-builder. Réparer le lockfile. Ajouter `*.tsbuildinfo` au `.gitignore`.
9. Un test unitaire pour chaque point ci-dessus.

### Étape 2 — Rendre réelles les fonctions simulées (une par une, dans cet ordre)

| Fonction | Piste technique (à valider) |
|---|---|
| Effacement sécurisé | Vraies passes d'écriture sur `\\.\PhysicalDriveN`, ou Secure Erase via l'outil du fabricant. Sinon, retirer les noms DoD/Gutmann. |
| Clonage de disque | Copie secteur par secteur en lecture/écriture brute de `\\.\PhysicalDriveN` (module natif ou outil C#/Rust séparé), puis ajustement de la dernière partition. |
| Migration de l'OS | Clonage des partitions EFI + MSR + Windows + WinRE, puis `bcdboot` sur la cible. |
| Test de surface | Lecture de tous les secteurs avec mesure du temps et des erreurs. |
| S.M.A.R.T. réel | `Get-StorageReliabilityCounter` (déjà en partie fait), ou `smartctl` si présent. |
| Média WinPE | Windows ADK (`copype`, `MakeWinPEMedia`). |
| Sauvegarde / image | `wbadmin` ou image VHDX (`New-VHD` + copie). |
| Récupération de partitions | Le plus dur. Possibilité d'appeler TestDisk (déjà dans `06_OUTILS_SYSTEME\Testdisk`). |
| App Mover | `robocopy` + jonction `mklink /J`, avec retour arrière. |

Opérations d'écriture brute : passer par un **processus séparé** (petit exécutable C# ou Rust) appelé avec des arguments validés. Pas de code natif dans le renderer.

### Étape 3 — Interface

Appliquer la charte Rapide iT à toute l'app (`src/index.css`). Contrastes WCAG AA. Le badge « Simulation / Réel » doit toujours rester visible.

## Fichiers touchés

- `HANDOFF.md` (créé, non commité). Rien d'autre.

## Pièges

- **Ne jamais tester sur le PC de Farid.** Utiliser une machine virtuelle (Hyper-V ou VirtualBox) avec des disques virtuels jetables. Ou `New-VHD` + `Mount-VHD` pour créer un faux disque.
- L'app tourne en **Administrateur** : une erreur peut détruire des données.
- Windows peut renuméroter les partitions et les disques. Toujours relire avant d'écrire.
- `npm ci` échoue tant que le lockfile n'est pas réparé : utiliser `npm install` d'abord.
- FAT32 au-delà de 32 Go : `Format-Volume` refuse. Il faut un formateur dédié.
- Ne pas affirmer qu'une fonction marche sans preuve : test lancé, capture, ou log de la VM.
- Aucun push sur GitHub ni release sans l'accord de Farid.

## Qui reprend

**Antigravity (`agy`)** pour le code des étapes 1 à 3.
**Claude Code** pour relire l'étape 1 avant de passer à l'étape 2 (relecture critique ciblée).
