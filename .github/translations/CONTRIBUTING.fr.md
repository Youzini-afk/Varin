[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | Français | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# Contribuer à Varin

Varin est un harness d'agents qui doit bien fonctionner dès l'installation. Les contributions les plus utiles permettent au même modèle d'aller plus loin, ou améliorent les réglages par défaut pour les personnes qui les utilisent :

- les outils, et la façon dont leurs résultats parviennent au modèle et à la conversation ;
- le contexte, la recherche d'informations et la mémoire ;
- les fournisseurs et les protocoles de modèles ;
- les extensions, les templates et les exemples ;
- les réglages par défaut des modes Programmation, Recherche, Bureautique et Général ;
- la documentation et les traductions ;
- les comptes rendus de tests sur votre plateforme : Windows, macOS, Linux, Docker ou un Host distant.

## Choisir un point de départ

Cherchez les travaux liés dans les [issues](https://github.com/Youzini-afk/Varin/issues), les [pull requests](https://github.com/Youzini-afk/Varin/pulls) et les [Discussions](https://github.com/Youzini-afk/Varin/discussions). Un petit problème reproductible convient bien à une première contribution ; les issues portant le label [good first issue](https://github.com/Youzini-afk/Varin/labels/good%20first%20issue) sont un bon point de départ. Pour un changement plus large, décrivez le parcours à améliorer dans [Ideas](https://github.com/Youzini-afk/Varin/discussions/categories/ideas) ou dans une demande de fonctionnalité, et partagez tôt un croquis ou un prototype. Les questions vont dans [Q&A](https://github.com/Youzini-afk/Varin/discussions/categories/q-a) ; la page [Obtenir de l'aide](SUPPORT.fr.md) indique les autres canaux.

Un rapport de bug est déjà utile. Indiquez la version, le mode d'installation, le comportement observé et les étapes ou un exemple pour le reproduire. Retirez les identifiants et les données privées des journaux et captures. Signalez les vulnérabilités selon la [politique de sécurité](../SECURITY.md).

## Préparer l'environnement

Créez un fork et clonez le dépôt. Le développement utilise Node.js 24, Bun 1.3.14, Git, Rust, une chaîne C/C++ et CMake. Le [guide de développement](../../docs/development.md) décrit l'environnement et les commandes.

À la racine du dépôt :

```sh
bun install --frozen-lockfile
git switch -c your-change
bun run dev
```

Ouvrez l'URL de l'interface affichée dans le terminal. Pour le bureau, utilisez `bun run electron:dev`. Configurez un modèle dans les paramètres si votre modification nécessite un agent en cours d'exécution.

Lisez [AGENTS.md](../../AGENTS.md) et le README ou DOCUMENTATION le plus proche du code concerné.

## Trouver le bon module

| Domaine | Point de départ |
| --- | --- |
| Conversations, panneaux, éditeurs et interface partagée | [packages/ui](../../packages/ui/DOCUMENTATION.md) |
| Boucle de l'agent, outils, contexte, permissions, nouvelles tentatives et reprise | [Runtime des agents](../../kernel/crates/varin-runtime/README.md), [runtime](../../docs/runtime.md), [recherche d'informations et contexte](../../docs/retrieval.md) |
| Services web, de recherche, de documents, Office, de navigateur et MCP utilisés par l'agent | [Services harness du Host](../../packages/web/application-host/lib/harness/DOCUMENTATION.md) |
| Fournisseurs de modèles, protocoles et comptes | [Modèles et comptes](../../packages/web/application-host/lib/models/DOCUMENTATION.md) |
| Services applicatifs et accès distant | [Application Host](../../packages/web/README.md) |
| Exécution des agents, historique, fichiers et processus | [Noyau Rust](../../kernel/README.md) |
| Contrats et création d'extensions | [Guide](../../docs/ops/varin-extension-authoring.md), [exemples](../../examples/extensions/README.md) |
| Guides utilisateur et traductions | [Documentation publique](../../packages/docs/CONTRIBUTING.md) |
| Assemblage du système | [Architecture](../../docs/architecture.md), [index](../../docs/README.md) |

Suivez la responsabilité existante du comportement : le runtime Rust gère les conversations et l'exécution, l'Application Host fournit les services de confiance, et les clients les présentent via les API communes. Préservez les fichiers et données des utilisateurs, et utilisez les interfaces d'extension établies.

## Modifier et vérifier

Gardez un problème cohérent par pull request. Lisez l'implémentation et ses appelants, suivez le style existant, utilisez les composants UI partagés et actualisez la documentation du comportement.

Choisissez les vérifications adaptées au changement. Réutilisez les tests existants ; ajoutez un test de régression ciblé pour un comportement important ou un bug reproduit. Le [guide de développement](../../docs/development.md#修改与验证) répertorie les vérifications par type de modification. Pour les documents et les liens, utilisez `bun run docs:validate`.

Pour l'interface, joignez une capture ou une vidéo de l'état concerné. Pour les performances, fournissez une mesure représentative. Indiquez les commandes exécutées, leurs résultats et les comportements pertinents que votre environnement n'a pas permis de vérifier.

Les guides publics et les documents de présentation du dépôt ont l'anglais pour langue source. Alignez les traductions existantes lorsque le comportement, les commandes ou les liens changent. Les documents d'ingénierie principaux sont en chinois ; les documents de paquets et proches du code gardent leur langue établie.

## Envoyer une pull request

Expliquez le problème et le comportement obtenu, puis les vérifications effectuées. Liez les issues concernées et ajoutez des images utiles. Le [modèle de PR](../pull_request_template.md) rassemble ces éléments.

Choisissez un titre de commit concis qui décrit la modification. Résolvez les conflits en tenant compte du comportement attendu et préservez les travaux sans rapport avec votre changement.

## Communauté et licence

Respectez le [Code de conduite](CODE_OF_CONDUCT.fr.md). Les Discussions, les issues et les pull requests sont les espaces communs pour parler du projet ; la page [Obtenir de l'aide](SUPPORT.fr.md) indique lequel convient.

En soumettant une contribution, vous acceptez qu'elle puisse être distribuée sous [AGPL-3.0-only](../../LICENSE). Conservez les mentions de droits d'auteur et de licence des éléments tiers importés ; consultez [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md).
