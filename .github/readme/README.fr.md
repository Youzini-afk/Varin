[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | Français | [日本語](README.ja.md)

<p align="center">
  <img src="../../.github/readme/assets/wordmark.svg" alt="Varin" width="720" />
</p>

<p align="center"><strong>Un espace de travail open source pour les agents IA.</strong></p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases">Télécharger</a> ·
  <a href="../../packages/docs/README.md">Guides</a> ·
  <a href="../../docs/ops/varin-extension-authoring.md">Créer une extension</a> ·
  <a href="../translations/CONTRIBUTING.fr.md">Contribuer</a>
</p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases"><img src="https://img.shields.io/github/v/release/Youzini-afk/Varin" alt="Release" /></a>
  <a href="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml"><img src="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
</p>

Réunissez vos modèles, outils, fichiers et projets dans un même espace. Travaillez avec un agent pour examiner un problème, écrire du code, lire des articles scientifiques ou créer une explication interactive. Suivez son travail et consultez les résultats dans la conversation.

Varin fonctionne sur ordinateur et dans le navigateur. Son client mobile se connecte à votre Host. Son propre runtime Rust gère l'exécution des agents et l'historique des conversations.

## Ce que vous pouvez faire

| Votre travail | Dans Varin |
| --- | --- |
| Avancer sur une tâche | Conversations en streaming, messages en attente, plans, agents enfants et suivis planifiés. |
| Développer un projet | Édition de fichiers, différences, Git et worktrees, terminaux, recherche de code et outils de langage. |
| Lire et chercher | Recherche web et scientifique, lecture de PDF et conservation des sources auprès de la conversation. |
| Créer du contenu visuel | Génération et édition d'images, graphiques HTML interactifs et petits outils dans les messages. |
| Choisir vos outils | Modèles cloud ou locaux, permissions, instructions, skills et serveurs MCP. |
| Changer de machine | Espace de travail local ou connexion à un Host distant depuis le bureau, le web ou le mobile. |

Les espaces Agent, IDE, Research et Bot proposent des dispositions adaptées à ces usages. IDE est disponible sur ordinateur et sur le web ; les autres prennent aussi en charge le mobile. [Détails des espaces de travail](../../docs/workbench.md)

## Commencer

| Utilisation | Point de départ |
| --- | --- |
| Application Windows, macOS ou Linux | [Télécharger une version](https://github.com/Youzini-afk/Varin/releases). Choisissez le fichier adapté à votre système et à votre architecture CPU. |
| Serveur ou ordinateur personnel, accessible dans le navigateur | [Hébergement avec Docker](../../docs/ops/cloud-deployment.md) : stockage persistant, mot de passe et accès distant. |
| iOS ou Android | [Configuration mobile](../../packages/mobile/README.md). Le client se connecte à un Host existant. |
| Depuis les sources | Suivez les étapes ci-dessous. |

Dans les paramètres, connectez un fournisseur de modèles ou un service local. Sélectionnez un modèle, choisissez un dossier de projet si la tâche en a besoin, puis démarrez une conversation. La zone de saisie permet de choisir les permissions et le mode général ou recherche.

Varin est en développement actif avant la version 1.0. Cette page décrit les sources actuelles ; les [notes de version](https://github.com/Youzini-afk/Varin/releases) décrivent les builds publiés. Sauvegardez les données importantes de l'application avant une mise à niveau.

## Exécuter depuis les sources

Utilisez **Node.js 24**, **Bun 1.3.14**, Git et la chaîne Rust indiquée dans [rust-toolchain.toml](../../kernel/rust-toolchain.toml). Les dépendances natives nécessitent aussi une chaîne C/C++ et CMake. Consultez le [guide de développement](../../docs/development.md).

```sh
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

Ouvrez l'URL de l'interface affichée dans le terminal. Cette commande lance l'interface web et l'Application Host.

Pour l'application de bureau, exécutez `bun run electron:dev` dans le même dépôt. La commande prépare le noyau natif et lance Electron avec l'interface de développement. [Développement et packaging desktop](../../packages/electron/README.md#development)

## Étendre votre espace de travail

Le harness de Varin relie le modèle aux outils, au contexte, aux permissions, aux tâches en arrière-plan et aux agents enfants. Le runtime Rust conserve les conversations et les traces d'exécution ; l'Application Host partagé fournit les connexions aux modèles et les services de l'espace de travail.

Les outils courants sont déclarés directement. Les autres capacités disponibles disposent d'un index et de descriptions à la demande, ce qui garde stable le préfixe des déclarations lors de leur découverte. Les outils de recherche sont disponibles à la demande en mode général et déclarés directement en mode recherche.

Les extensions peuvent ajouter des outils, des adaptateurs de modèles, des panneaux ou des dispositions complètes. Commencez par le [guide de création](../../docs/ops/varin-extension-authoring.md), le [SDK](../../packages/extension-sdk/README.md) ou les [exemples](../../examples/extensions/README.md).

Les détails d'implémentation sont dans l'[architecture](../../docs/architecture.md), le [runtime](../../docs/runtime.md) et l'[index de documentation](../../docs/README.md).

## Contribuer

Les rapports de bugs, améliorations d'interface et d'outils, documents, traductions et retours sur les plateformes sont bienvenus. Le [guide de contribution](../translations/CONTRIBUTING.fr.md) explique la préparation, le choix d'une modification et l'envoi d'une pull request.

[Signaler un bug](https://github.com/Youzini-afk/Varin/issues/new?template=bug.yml) · [Proposer une fonctionnalité](https://github.com/Youzini-afk/Varin/issues/new?template=feature.yml) · [Signaler une vulnérabilité en privé](../SECURITY.md)

Merci à la communauté [LinuxDO](https://linux.do) pour son soutien.

## Origine et licence

Varin est un projet indépendant issu du fork OpenChamber de son mainteneur.

Le projet est distribué sous la [GNU Affero General Public License v3.0](../../LICENSE) (`AGPL-3.0-only`). Les versions modifiées accessibles par le réseau doivent fournir leur code source correspondant selon la licence. Les mentions de droits d'auteur et de tiers sont conservées dans [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md).
