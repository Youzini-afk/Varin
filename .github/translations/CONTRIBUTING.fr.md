[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | [简体中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-CN.md) | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | Français | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# Contribuer à Varin

Les contributions au runtime, aux interfaces de bureau et distantes, aux extensions, à la documentation,
à l'accessibilité et aux plateformes sont les bienvenues. Ce guide décrit le processus public de contribution.
[AGENTS.md](../../AGENTS.md) contient les règles du dépôt ; le [guide de développement](../../docs/development.md)
explique l'installation, les commandes et la validation ; l'[architecture](../../docs/architecture.md) décrit les responsabilités.

## Avant de commencer

- Lisez le [Code de conduite](CODE_OF_CONDUCT.fr.md).
- Recherchez les issues et pull requests existantes pour éviter les doublons. Utilisez les
  [Issues GitHub](https://github.com/Youzini-afk/Varin/issues) pour les bugs reproductibles, les propositions
  de fonctionnalités et les discussions techniques ciblées.
- Signalez les vulnérabilités en privé selon la [politique de sécurité](../SECURITY.md). Ne publiez pas
  de détails d'exploitation dans les issues, pull requests, journaux ou captures d'écran.
- Pour une modification importante du produit ou de l'architecture, discutez tôt du résultat attendu
  pour l'utilisateur et des frontières concernées. Un prototype peut clarifier une question de conception.

## Réaliser une modification

Lisez l'implémentation responsable, ses consommateurs et le README ou DOCUMENTATION le plus proche.
Gardez la modification ciblée, préservez le travail sans rapport et suivez le style et les composants UI existants.

Le runtime natif Rust Agent gère les conversations et l'exécution du produit. Son Catalog possède
l'historique Thread/branche, les files, les Runs et les Operations ; l'Application Host de confiance
fournit les modèles, les identifiants et les services métier. Respectez ces responsabilités sans
copier l'état dans une autre couche. Les anciennes données Pi sont préservées sans importation ni
rétablissement d'un runtime de secours.

Intégrez les extensions par leurs interfaces publiques et préservez leurs configurations et données.
Les opérations privilégiées appartiennent au Host de confiance, jamais au renderer. Consultez les règles
de [sécurité](../../docs/security.md) et d'[extension](../../docs/extensions.md) applicables.
Ne journalisez jamais les identifiants ni le contenu privé des utilisateurs.

Les formats internes obsolètes ne nécessitent ni lecteurs de compatibilité ni migration automatique.
Un stockage non pris en charge doit laisser les données existantes intactes. Les fichiers de travail,
l'historique Git, les données natives Pi et les configurations externes restent des biens de l'utilisateur ;
la durabilité et la récupération du format actuel restent nécessaires.

## Documentation

Le code, les types, les schémas, les tests et les scripts des packages définissent le comportement actuel.
La documentation explique les responsabilités, mécanismes, contraintes et raisons de conception utiles ;
Git conserve l'historique. Mettez à jour l'explication concernée lorsque le comportement change.
L'[index documentaire](../../docs/README.md) indique le document responsable ; [AGENTS.md](../../AGENTS.md)
précise le traitement des conceptions et plans en cours.

La documentation publique destinée aux utilisateurs, le README racine, ce guide et la politique de
sécurité ont l'anglais comme langue source. Synchronisez les traductions existantes concernées lorsque
les faits, commandes, consignes de sécurité ou liens changent. Conservez la navigation linguistique
des documents racines localisés.

Les principaux documents d'ingénierie sont en chinois. Les documents proches du code ou propres aux
packages gardent leur langue établie, sans nécessiter de traductions parallèles. La convention de langue
de la documentation publique ne change pas celle de la documentation d'ingénierie.

## Validation

Choisissez les vérifications selon le comportement modifié et ses consommateurs. Consultez le
`package.json` le plus proche et le [guide de développement](../../docs/development.md) pour les commandes.

Réutilisez les vérifications pertinentes. Ajoutez un test de régression pour protéger un comportement
important ou un défaut reproduit ; chaque modification ne nécessite pas un nouveau test. Supprimez les
vérifications obsolètes ou redondantes. Les contrats partagés demandent des preuves venant de leurs
consommateurs ; l'empaquetage et les plateformes demandent l'environnement approprié.
La vérification des types seule ne démontre pas ces comportements.

Pour l'UI, utilisez des captures ou enregistrements utiles à la vérification des dispositions, thèmes et
états concernés. Appuyez les affirmations de performance sur des mesures représentatives. Indiquez ce
qui a été exécuté et ce qui reste non vérifié. Élargissez la validation si un nouvel échec ou un risque
non résolu le justifie.

## Commits et pull requests

Utilisez des titres de commit concis décrivant la modification. Expliquez dans la pull request le
problème, le comportement obtenu, les vérifications et les limites importantes. Décrivez les changements
de responsabilité ou de contrat externe lorsqu'ils aident la revue. Adaptez le détail au travail.

Gardez la branche à jour sans réécrire le travail d'autrui. Résolvez les conflits en vérifiant le
comportement prévu et le responsable de l'état, sans choisir mécaniquement un côté. Préservez les
modifications utilisateur sans rapport et évitez le nettoyage Git destructif.

Les rapports de bugs, améliorations documentaires, traductions et observations sur les plateformes
sont aussi utiles ; fournissez l'environnement et les étapes de reproduction pertinents.

## Licence

En soumettant une contribution, vous acceptez sa distribution sous la
[GNU Affero General Public License v3.0](../../LICENSE) de Varin (`AGPL-3.0-only`) et le maintien,
pour le matériel tiers importé, des mentions requises par les [avis sur les composants tiers](../../THIRD_PARTY_NOTICES.md).
