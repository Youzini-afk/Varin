[English](../../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | Français | [日本語](README.ja.md)

# Varin

<p align="center">
  <img src="../../packages/electron/resources/icons/app-icon.svg" alt="Varin" width="128" />
</p>

[![CI](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml)
[![Docker Images](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](../../LICENSE)

**Un espace de travail Agent indépendant et un cadre d’exécution pour le code, la recherche et les
projets, sur ordinateur, sur le web et sur mobile.**

Varin utilise son propre runtime Agent natif en Rust. Son Catalog possède les Threads, les branches,
l’historique durable des conversations et l’exécution. L’Application Host partagé gère les connexions
et comptes de modèles, les ressources de l’agent, la configuration MCP et les services de confiance
de l’espace de travail. Les clients affichent et contrôlent ces services via les mêmes API applicatives.
Voir l’[architecture](../../docs/architecture.md).

> [!IMPORTANT]
> Varin est en pré-1.0 et en développement actif. Les interfaces produit et le protocole privé du
> runtime évoluent ensemble ; l’interopérabilité entre versions n’est pas garantie. Sauvegardez les
> espaces de travail importants et fixez un digest d’image testé pour les déploiements persistants.
> Les données existantes ne sont ni importées, ni migrées, ni réécrites automatiquement ; les formats
> de stockage internes non pris en charge sont refusés.

## Ce que fournit Varin

- **Conversations natives :** historique des Threads et branches, streaming, file d’entrées, choix
  du modèle et du niveau de raisonnement, sous-tâches, plans, permissions et restauration, avec le
  Catalog natif comme autorité. [Runtime](../../docs/runtime.md)
- **Un espace de développement :** fichiers, différences, Git, worktrees, terminaux, recherche,
  serveurs de langage et débogage. Le bureau et le web partagent Monaco ; l’éditeur léger mobile
  utilise la même autorité documentaire, avec une gestion explicite des modifications non enregistrées
  et des conflits. [Workbench](../../docs/workbench.md)
- **Exécution et restauration :** les sources admises distinguent fichiers courants, instantanés et
  travail matérialisé. Rust possède le stockage et les ressources d’exécution ; permissions,
  annulation et achèvement réel restent des faits distincts. [Ressources](../../docs/resources.md)
- **Recherche et contexte :** recherche exacte et sémantique, navigation dans le code, notes à portée
  définie, connaissances du Bot, découverte web et scientifique, et documents PDF conservant leurs
  sources et images de pages. [Recherche et contexte](../../docs/retrieval.md)
- **Configuration gérée par le Host :** canaux de modèles, comptes, points de terminaison, instructions
  et compétences de l’agent, connexions MCP dans des réglages dédiés. Les identifiants et l’exécution
  privilégiée restent sous la responsabilité des services de confiance.
  [Modèles](../../packages/web/application-host/lib/models/DOCUMENTATION.md),
  [ressources de l’agent](../../packages/web/application-host/lib/agent-resources/DOCUMENTATION.md),
  [MCP](../../packages/web/application-host/lib/mcp/DOCUMENTATION.md)
- **Utilisation locale et distante :** Electron intègre l’Application Host ; les clients web et
  mobiles Capacitor s’y connectent. Hosts distants, appairage, tunnels et déploiements conteneur/SSH
  conservent des limites explicites d’accès et de plateforme.
  [Sécurité](../../docs/security.md) · [Exploitation](../../docs/ops/README.md)

Quatre Workbench Profiles intégrés proposent **Agent Workspace**, **IDE Workbench**, **Research
Workbench** et **Varin Bot**. Agent, Research et Bot fonctionnent sur bureau, web et mobile ; IDE sur
bureau et web. Ces profils sont des extensions Varin : vous pouvez remplacer toute l’interface ou
certaines contributions, tandis que l’orientation du travail, les documents et l’identité du Thread
restent indépendants de la présentation.

La prise en charge des fournisseurs de modèles, de Computer/VM et des paquets dépend de l’environnement
réel. Des tests ciblés ne constituent pas une validation complète de chaque plateforme ; voir les
[critères de validation du runtime](../../docs/runtime-acceptance.md).

## Créer des extensions Varin

Les extensions Varin ajoutent des interfaces de workbench et des capacités de confiance au Host via
des contrats publics. Les outils sont `@varin/extension-contract`, `@varin/extension-sdk`, l’adaptateur
React 19 facultatif `@varin/extension-react`, `@varin/extension-surface` et `@varin/extension-cli`.

Lorsque des versions publiées sont disponibles dans votre registre :

```sh
npx @varin/extension-cli init ./my-extension --id dev.example.my-extension --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

Voir les [extensions](../../docs/extensions.md) et le [guide de création](../../docs/ops/varin-extension-authoring.md)
pour le travail depuis les sources, les manifests, capacités, cycles de vie, publications et tests.

## Télécharger l’application de bureau

Consultez les [GitHub Releases](https://github.com/Youzini-afk/Varin/releases) pour les distributions
disponibles et leurs plateformes et versions. Les procédures source et conteneur suivent.

## Démarrer depuis les sources

Prérequis : Node.js 22.19 ou plus récent (Node.js 24 est la base du développement source), Bun 1.3.14,
Git et la chaîne Rust définie dans [kernel/rust-toolchain.toml](../../kernel/rust-toolchain.toml).
Voir le [guide de développement](../../docs/development.md) pour la préparation et la vérification des plateformes.

Le noyau Rust est obligatoire. En développement, Cargo peut le lancer en l’absence d’un binaire préparé ;
`bun run kernel:build` produit l’exécutable release vérifié par manifest nécessaire aux distributions.
La disponibilité est vérifiée auprès de l’Application Host réel et du catalogue natif de Threads.

### Développement web

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

Ouvrez l’URL Vite affichée dans le terminal. Cette commande démarre l’UI et l’Application Host de
confiance sur des ports disponibles. Configurez les connexions et comptes de modèles dans les réglages
avant de commencer un travail utilisant un modèle.

### Développement bureau

```bash
bun run electron:dev
```

Pour tester les ressources UI intégrées :

```bash
bun run electron:dev:bundled
```

### Programme d’installation Windows

À exécuter sous Windows :

```powershell
bun run electron:build:win
bun run electron:smoke:win
```

L’installeur NSIS, les métadonnées de mise à jour et la blockmap sont écrits dans `packages/electron/dist`.
Sans identifiants de signature, le résultat n’est pas signé. Voir le [guide de packaging bureau](../../packages/electron/README.md#packaging).

## Exécuter l’image cloud

Compose utilise `ghcr.io/youzini-afk/varin-slim:latest` par défaut. Sur un hôte Docker Linux :

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
umask 077
printf 'VARIN_UI_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

Ouvrez `http://127.0.0.1:3000` avec le mot de passe généré. Une exposition à Internet nécessite un
reverse proxy TLS ou un tunnel approuvé respectant les [règles de transfert](../../docs/ops/REVERSE_PROXY.md).
En production, fixez `VARIN_IMAGE` à un digest immuable testé.

Pour disposer d’outils de développement Python, Java, Go ou Rust dans le conteneur :

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

Voir le [déploiement cloud](../../docs/ops/cloud-deployment.md) pour les chemins persistants, variables
d’environnement, variantes d’image, architectures prises en charge et déploiements SSH avec contrôle
de santé et retour arrière.

## Architecture et développement

Commencez par l’[index documentaire](../../docs/README.md), l’[architecture](../../docs/architecture.md)
et le [guide de développement](../../docs/development.md). L’Application Host intègre l’exécution du
Catalog natif, le stockage et les ressources gérés par Rust, ainsi que les autorités distinctes de
connaissances et d’extensions ; les renderers ne possèdent ni identifiants ni exécution durable.

Lisez [CONTRIBUTING](../CONTRIBUTING.md) et [AGENTS](../../AGENTS.md) avant de contribuer. Les scripts
des paquets définissent les commandes ; choisissez des vérifications adaptées au changement.

Merci à la communauté [LinuxDO](https://linux.do) pour son soutien.

## Origine et licence

Varin est un projet indépendant issu du fork OpenChamber de son mainteneur.

L’œuvre combinée est distribuée sous la [GNU Affero General Public License v3.0](../../LICENSE)
(`AGPL-3.0-only`). Les versions modifiées proposées sur un réseau doivent fournir leur code source
correspondant conformément à la licence. Les mentions de copyright et obligations tierces conservées
figurent dans [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md).
