[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | Français | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# Contribuer à Varin

Merci de contribuer à l'amélioration de Varin. Les contributions sont les bienvenues dans tous les domaines :
limite d'exécution Pi, interfaces de bureau et distantes, intégrations d'extensions, documentation, tests,
accessibilité et prise en charge des plateformes.

Ce guide décrit le processus public de contribution. [AGENTS.md](../../AGENTS.md), le README du package le plus proche
et les documents d'architecture responsables de la fonctionnalité contiennent les règles détaillées applicables au
travail d'implémentation dans le dépôt.

## Langues de la documentation

La documentation destinée aux utilisateurs est par défaut rédigée en anglais. Le README racine, le guide de
contribution, la politique de sécurité et la racine du contenu `packages/docs` constituent la source anglaise. Le
chinois simplifié et les autres langues sont des traductions.

Dans une même modification, gardez synchronisés, dans toutes les langues concernées, le comportement factuel, les
commandes, les consignes de sécurité et les liens. Rédigez d'abord les nouvelles pages de documentation en anglais,
puis ajoutez les miroirs `zh-cn/` et des autres langues. Chaque document racine localisé doit commencer par un sélecteur
de langue afin que les lecteurs n'aient jamais besoin de revenir à l'index du dépôt pour changer de langue.

## Avant de commencer

- Lisez le [Code de conduite](CODE_OF_CONDUCT.fr.md).
- Utilisez les [Issues GitHub](https://github.com/Youzini-afk/Varin/issues) pour les bugs reproductibles, les
  propositions de fonctionnalités et les discussions techniques ciblées.
- Envoyez les vulnérabilités via le processus privé décrit dans [SECURITY.md](../SECURITY.md). Ne publiez pas de
  détails d'exploitation dans une issue, une discussion, une pull request, un journal ou une capture d'écran.
- Recherchez les issues et pull requests existantes avant de commencer une modification en double.
- Pour une modification importante du produit ou de l'architecture, décrivez le résultat utilisateur et les limites
  concernées avant d'investir dans une implémentation complète. Un prototype est le bienvenu lorsqu'il facilite
  l'évaluation des compromis.

## Principes du projet qui influencent les contributions

Varin n'est pas un wrapper générique autour de plusieurs CLI d'agents de code. Il possède un domaine natif Pi
unique et un seul contrat d'exécution préliminaire actuel.

1. **Gardez Pi comme autorité.** Pi possède les sessions, les modèles, l'authentification, les paramètres, les
   packages et le runtime des extensions. Projetez un contrat Varin compatible JSON ; ne recopiez pas l'état de Pi
   dans un schéma applicatif parallèle.
2. **Préservez la propriété des plugins.** Intégrez les extensions via les commandes, événements, paramètres et ponts
   de capacités publics. N'analysez pas les bases de données privées et ne dupliquez pas les migrations de plugins
   simplement pour créer une interface graphique.
3. **Évitez le sédiment de compatibilité.** Pendant le développement pré-1.0, toutes les surfaces du produit évoluent
   ensemble. Supprimez les chemins OpenCode obsolètes et les anciens chemins Varin dès que le remplacement est
   accepté ; n'accumulez pas de couches de compatibilité de type protocole v13/v14 sans besoin réel de données
   persistées ou de client externe.
4. **Appliquez les privilèges à la frontière de confiance.** Les renderers et les clients distants ne peuvent pas
   s'autoriser eux-mêmes. Validez les opérations sur le système de fichiers, les processus, le réseau, la confiance
   dans le projet et les identifiants dans l'hôte qui possède la capacité.
5. **N'ajoutez pas de limites arbitraires au produit.** Évitez la troncature silencieuse, les plafonds de nombre de
   modèles, les délais d'attente courts ou les plafonds de concurrence cachés. Les budgets opérationnels doivent être
   des options de déploiement explicites, avec une sémantique d'échec visible.
6. **Gardez les échecs fidèles à la réalité.** Un échec faisant autorité n'est pas une réponse vide réussie. Rendez
   visibles l'annulation, l'échec partiel, le nettoyage, la nouvelle tentative, le retour arrière et les
   capacités indisponibles.

Lisez [Architecture](../../docs/architecture.md), [Conception de l'interface graphique des plugins](../../docs/design/plugin-gui-design.md),
[Récupération](../../docs/design/recovery.md) et [Modèle de sécurité](../../docs/design/security.md) lorsque ces limites s'appliquent.

## Configuration du développement

### Prérequis

- Node.js 22.19 ou version ultérieure ; Node.js 24 est la base de référence utilisée par la CI et pour le
  développement pris en charge
- Bun 1.3.14
- Git
- Git pour Windows et Git Bash pour les outils shell de Pi sous Windows

### Cloner et installer

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run check:pi
```

`bun.lock` fait autorité. Ne changez pas de gestionnaire de packages et ne régénérez pas le lockfile, sauf si la
modification de dépendance l'exige. Examinez attentivement les modifications des scripts de cycle de vie ; Varin
n'autorise intentionnellement à l'installation que les scripts requis.

## Surfaces de développement courantes

Exécutez les commandes depuis la racine du dépôt, sauf indication contraire.

| Objectif | Commande |
| --- | --- |
| Interface Web avec HMR et API de confiance | `bun run dev` |
| Observateur de build Web avec serveur | `bun run dev:web:full` |
| Bureau avec HMR Web | `bun run electron:dev` |
| Bureau utilisant les ressources compilées | `bun run electron:dev:bundled` |
| Empaqueter le bureau pour le système d'exploitation courant | `bun run electron:build` |
| Empaqueter l'installateur NSIS Windows x64 | `bun run electron:build:win` |
| Tester rapidement une build Windows décompressée | `bun run electron:smoke:win` |
| Compiler les ressources mobiles | `bun run mobile:build` |
| Compiler le runtime cloud canonique | `bun run build:cloud-runtime` |
| Valider le site de documentation | `bun run docs:validate` |

L'interface utilisateur partagée est une bibliothèque source plutôt qu'une application autonome. Exercez le
comportement de l'interface via Web ou Desktop afin que le contexte d'exécution soit réel.

## Choisir le package propriétaire

| Domaine | Propriétaire principal |
| --- | --- |
| Composants partagés, stores, paramètres, chat et interface graphique des plugins | `packages/ui` |
| Serveur navigateur/distant, API HTTP, transport WebSocket, CLI cloud | `packages/web` |
| Shell Windows/macOS/Linux, preload/IPC, SSH, mise à jour, empaquetage | `packages/electron` |
| Shell natif Capacitor | `packages/mobile` |
| Contrat filaire compatible JSON et validation | `packages/protocol` |
| Client runtime du navigateur/de l'éditeur | `packages/runtime-client` |
| Propriété des workers, routage, cycle de vie et arrêt | `packages/runtime-broker` |
| SDK Pi, sessions, packages, extensions et opérations de l'hôte de confiance | `packages/pi-host` |

Les modifications d'API partagées traversent souvent plusieurs packages, mais une seule couche doit rester
autorisée. Ne contournez pas un contrat manquant avec un store local sans rapport ou une vérification de privilèges
réalisée uniquement dans le renderer.

## Implémenter une modification

1. Identifiez la source de données faisant autorité, la frontière d'exécution de confiance, les surfaces du produit
   concernées et le comportement en cas d'échec.
2. Lisez `AGENTS.md`, le README ou `DOCUMENTATION.md` du package le plus proche, ainsi que chaque skill du projet
   correspondant avant de modifier du code produit importé.
3. Gardez la modification ciblée. Incluez le nettoyage et les tests directement nécessaires, mais séparez les
   refactorisations sans rapport qui rendent la revue plus difficile.
4. Ajoutez ou mettez à jour le test de régression le plus ciblé qui démontre le comportement à la frontière qui en
   est propriétaire.
5. Exercez chaque surface d'exécution dont le contrat a changé. La vérification des types d'un type partagé ne prouve
   pas que le comportement fonctionne dans Desktop, Web, le relais ou le mobile.
6. Mettez à jour la documentation utilisateur, contributeur, d'architecture, de sécurité ou d'exploitation dans la
   même modification lorsque son contrat a changé.

Lorsque vous modifiez une forme versionnée ou persistée, privilégiez une migration claire vers la forme actuelle.
Ne conservez les anciens lecteurs que si de vraies données utilisateur ou des clients déployés indépendamment
l'exigent, et documentez la condition de leur suppression.

## Validation

### Base de référence étendue

Exécutez les vérifications étendues pour les modifications de code, de dépendances, d'exports ou de build :

```bash
bun run type-check
bun run lint
bun run check:pi
bun run build
```

Exécutez les vérifications suivantes lorsque la frontière concernée s'applique :

| Modification | Éléments de preuve supplémentaires |
| --- | --- |
| Hôte Pi, protocole, broker ou client runtime | `bun run test:pi:dist` |
| Serveur Web ou transport | `bun run --cwd packages/web test` |
| Runtime cloud, Docker ou déploiement SSH | `bun run test:cloud` et une build de runtime canonique |
| Cycle de vie, architecture ou mise à jour Electron | `bun run --cwd packages/electron test:architecture` et/ou `test:updater` |
| Empaquetage Windows ou modules natifs | `bun run electron:build:win` puis `bun run electron:smoke:win` |
| Imports, exports ou suppression | `bun run dead-code` et une build de production de chaque surface concernée |
| Site de documentation | `bun run docs:validate` et vérification manuelle des liens locaux modifiés |
| `package.json` de l'espace de travail ou lockfile racine | `bun run update:cloud-runtime-lock` afin que `scripts/cloud-runtime.bun.lock` reste gelé |

La CI répète les principales vérifications de qualité sur Windows et Ubuntu. Les modifications du cloud/runtime
compilent également et testent rapidement les conteneurs candidats avant la promotion de tags installables.

Si une vérification requise ne peut pas être exécutée sur votre hôte, indiquez exactement ce qui n'a pas été testé et
pourquoi. Ne transformez pas une hypothèse de plateforme non testée en affirmation de prise en charge.

### Modifications visibles par l'utilisateur

Fournissez des éléments de preuve correspondant au HEAD actuel de la pull request :

- des captures d'écran pour les états statiques significatifs avant/après ;
- un court enregistrement pour les mouvements, le focus, le glisser-déposer, les gestes ou les interactions en
  plusieurs étapes ;
- des mises en page étroites et larges pour l'interface utilisateur partagée responsive ;
- les thèmes clair et sombre lorsque les couleurs ou les surfaces ont changé ;
- les états de chargement, vide, désactivé, erreur, contenu long et contraste élevé pertinents ;
- des mesures avant/après pour les affirmations concernant les performances, la mémoire, le CPU, le démarrage ou le
  rendu.

S'il n'y a aucune modification visible par l'utilisateur, expliquez pourquoi.

## Style du code et de la sécurité

- Utilisez TypeScript strict et évitez `any`, sauf si la frontière est véritablement dynamique et validée.
- Préférez les petits contrats discriminés, les retours anticipés et les transitions d'état explicites aux
  conditionnelles imbriquées ou aux replis implicites.
- Gardez les composants React fonctionnels et utilisez les tokens de thème et de typographie établis dans
  `packages/ui` pour les modes clair et sombre.
- Gardez les API preload d'Electron explicites et typées. N'ajoutez pas de passe-partout générique pour les canaux et
  n'importez pas Electron dans le code partagé du renderer.
- N'exécutez jamais les extensions Pi dans un renderer.
- Ne journalisez jamais les identifiants, les données d'autorisation ou d'association, le contenu des prompts, le
  contenu des fichiers, les réponses de fournisseurs contenant des données utilisateur ou les valeurs complètes de
  l'environnement.
- Utilisez le confinement des chemins fondé sur des limites canoniques du système de fichiers, et non sur de simples
  préfixes de chaînes.
- Utilisez des verrous et un remplacement atomique pour les écritures de configuration ou de métadonnées partagées ;
  rendez les modifications concurrentes et la récupération après crash testables.
- Préservez les modifications utilisateur et le travail sans rapport dans un arbre de travail non propre. N'utilisez
  pas le nettoyage Git destructif par commodité.

## Commits et pull requests

Utilisez des sujets de commit courts et impératifs, avec un préfixe de type conventionnel lorsqu'il est utile, par
exemple :

```text
feat: add Pi package capability diagnostics
fix: preserve session cwd across worktrees
docs: explain cloud rollback guarantees
```

Une pull request doit permettre à un reviewer de vérifier le résultat sans devoir reconstituer votre investigation.
Incluez :

- le problème de l'utilisateur ou du mainteneur et le comportement obtenu ;
- les objectifs exclus lorsque la portée voisine pourrait être ambiguë ;
- les packages, runtimes, formats persistés, contrats externes et frontières de confiance concernés ;
- les vérifications automatisées et manuelles exactes, y compris leurs résultats ;
- les considérations importantes de risque, d'échec, de nettoyage, de retour arrière, de compatibilité et
  de sécurité ;
- les éléments visuels ou empiriques actuels lorsque cela s'applique ;
- tout ce que vous n'avez pas pu vérifier.

Gardez la branche à jour sans réécrire le travail des autres contributeurs. Résolvez les conflits en réévaluant le
comportement et la propriété, et non en choisissant mécaniquement un côté du diff.

## Contributions sans code

Vous pouvez également aider en :

- signalant un bug reproductible ou un workflow déroutant ;
- testant sur un autre système d'exploitation, navigateur, architecture ou taille d'écran ;
- améliorant la configuration, le déploiement, l'accessibilité, la localisation ou la documentation de dépannage ;
- vérifiant une mise à jour d'extension Pi maintenue et en documentant les éléments de compatibilité ;
- proposant une interaction Pi-native plus claire ou une surface de configuration de plugin.

## Licence

En soumettant une contribution, vous acceptez qu'elle puisse être distribuée sous la
[GNU Affero General Public License v3.0](../../LICENSE) de Varin (`AGPL-3.0-only`) et que le matériel tiers importé
conserve les mentions requises par les [avis sur les composants tiers](../../THIRD_PARTY_NOTICES.md).
