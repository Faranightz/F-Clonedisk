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

---

## Relecture Claude Code du 21/11/2026 (commits 75dccc6 et d772f33)

Contrôles : `npm ci` OK · build OK · `npm test` 12/12 · `npm audit --omit=dev` 0 faille · `npm audit` 6 moyennes (outils de build) · `dotnet build` **impossible** : le SDK .NET n'est pas installé sur le PC.

Note : l'étape 2 a été faite sans attendre la relecture de l'étape 1, contrairement au plan.

### Étape 1 : validée
Vrais numéros de partition, identité du disque vérifiée avant chaque opération, file validée en entier, confirmation avec les vraies commandes, contrôle par lettre, noms de volume en liste blanche, `mbr2gpt /validate`, Electron 45. Bon travail.

### Étape 2 : à corriger AVANT tout essai, même sur VM

1. **[Critique] Clonage : le disque source n'est pas vérifié.** Seule l'identité de la cible est contrôlée (`diskEngine.ts:553`). Si les numéros changent, on peut copier un disque vide SUR le disque source. → Envoyer et vérifier `sourceIdentity` aussi (clone_disk et migrate_os).
2. **[Critique] Écriture brute sur un disque encore monté.** Windows bloque l'écriture sur les zones des volumes montés : wipe et clone échoueront en plein milieu (disque à moitié effacé). → Avant : `Set-Disk -IsOffline $true` sur la cible (et lecture seule de la source). Après : remettre en ligne. Dans le worker, gérer `FSCTL_LOCK_VOLUME` + `FSCTL_DISMOUNT_VOLUME` si besoin.
3. **[Critique] Migration de l'OS ne peut pas marcher.**
   - Copier brut le disque Windows en cours d'utilisation donne un système de fichiers incohérent. → Passer par un cliché VSS, ou ne proposer la migration que depuis WinPE.
   - Après la copie, les deux disques ont le même GUID : Windows met la copie hors ligne. → Changer le GUID du disque cible (`Set-Disk -Guid` ou réécriture GPT).
   - `bcdboot Z:\Windows /s S:` : les lettres Z: et S: ne sont jamais attribuées. → Attribuer les lettres avant (`Set-Partition -NewDriveLetter`).
4. **[Haute] Clonage vers un disque plus grand (GPT).** L'en-tête GPT de secours reste au milieu du disque. → Le déplacer en fin de disque après la copie, puis agrandir la dernière partition.
5. **[Haute] E/S sans tampon (`FILE_FLAG_NO_BUFFERING`).** Les `byte[]` .NET ne sont pas alignés sur 4096 et `FileStream` ajoute son propre tampon : risque d'erreur « paramètre incorrect ». → `NativeMemory.AlignedAlloc(4096)`, `bufferSize: 0`, tailles multiples de la taille de secteur physique (4Kn = 4096).
6. **[Haute] Le worker n'a jamais été compilé.** Installer le SDK .NET 8 (accord de Farid), lancer `npm run build:worker`, et ajouter `electron/bin` dans `extraResources` d'electron-builder (sinon l'exe n'est pas dans l'installateur).
7. **[Moyenne] « Sauvegarde VHDX » = copie de fichiers robocopy.** Ce n'est pas une image système restaurable. → La renommer « Copie de fichiers vers VHDX », ou faire une vraie image (`wbadmin start backup -allCritical` ou copie de bloc via VSS).
8. **[Moyenne] Test de surface : il lit 192 blocs de 1 Mo, pas tout le disque.** `badCount` n'augmente pas quand `read < 512`. → Proposer « rapide » (échantillon) et « complet » (tout le disque), et corriger le compteur.
9. **[Basse] Aperçu de commande** `DiskWorker ... && bcdboot` : ce n'est pas ce qui s'exécute. Afficher les vraies étapes.

### Ordre
Points 1, 2, 5, 6 → compilation du worker → test sur VM (disques virtuels jetables) avec preuves (logs, captures) → points 3, 4 → 7, 8, 9 → nouvelle relecture Claude Code.

---

## Corrections Claude Code du 22/11/2026 (non commitées)

Preuves : `npm test` 17/17 · `npm run build` OK · scripts PowerShell générés analysés par le parseur PowerShell : 0 erreur de syntaxe. **Le worker C# n'est toujours pas compilé** (SDK .NET 8 absent) : à compiler et tester avant tout usage.

| Point | État |
|---|---|
| 1. Identité du disque source | Fait. `sourceIdentity` exigé, vérifié avant exécution, source ≠ cible, cible = `diskNumber` vérifié. Confirmation affiche SOURCE et CIBLE. |
| 2. Disque monté | Fait. `withDisksOffline()` met source et cible hors ligne avant wipe/clone/migration et les remet en ligne même en cas d'erreur. |
| 3. Migration OS | Fait en partie. Refus si la source est le Windows en cours (à lancer depuis WinPE). Nouveau GUID après copie. Le script trouve la partition EFI et la partition Windows, prend des lettres libres, lance bcdboot, retire la lettre EFI (try/finally). GPT/UEFI uniquement. |
| 4. GPT de secours | Fait dans le worker : en-tête et table de secours replacés en fin de disque, CRC recalculés, ancien en-tête effacé, MBR protecteur ajusté. MBR : nouvelle signature. |
| 5. E/S alignées | Fait. `NativeMemory.AlignedAlloc(4096)` + `RandomAccess`, plus de `FileStream`. Refus si les tailles de secteur source et cible diffèrent. |
| 6. Packaging | Fait. `extraResources` → `resources/worker`, `build:win` lance `build:worker`, `electron/bin/` ignoré par Git. |
| 7. VHDX | Fait. Renommé « Copie de fichiers vers un VHDX (non démarrable) ». |
| 8. Test de surface | Fait côté worker : modes `quick` et `full`, compteur corrigé. **Reste :** l'écran du test de surface est encore simulé, il n'appelle pas `window.fClonedisk.runSurfaceTest`. |
| 9. Aperçu des commandes | Fait. Les vraies étapes s'affichent (hors ligne, worker, en ligne, bcdboot). |

### Reste à faire (Antigravity)
1. Installer le SDK .NET 8 (accord de Farid), `npm run build:worker`, corriger les erreurs de compilation éventuelles.
2. Brancher l'écran du test de surface sur `runSurfaceTest(disk, 192, 'quick' | 'full')`, avec un choix rapide/complet.
3. Inclure F-Clonedisk dans le média WinPE (migration et clone du disque Windows ne marchent que depuis WinPE).
4. Tests sur VM avec disques virtuels jetables (`New-VHD`), preuves à l'appui : effacement, clone MBR, clone GPT vers disque plus grand (vérifier avec `diskpart` > `list disk` que les deux disques restent en ligne), migration depuis WinPE puis démarrage de la VM sur le disque cible.
5. À vérifier sur VM : `Add-PartitionAccessPath` sur la partition EFI (si refus, utiliser `diskpart assign letter`).
