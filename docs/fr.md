# Agur

Suivez votre contrat d'eau [Agur](https://ael.agur.fr) dans Gladys : index du
compteur, consommation entre deux relevés, consommation moyenne par jour,
montant des factures et montant restant à payer, avec leur historique.

L'intégration fonctionne aussi avec les autres services d'eau qui utilisent le
même espace client : **Grand Paris Sud** et **Eau de Paris**.

## Prérequis

- Un compte sur l'espace client de votre service d'eau, avec au moins un
  contrat.
- Une connexion internet sur la machine qui fait tourner Gladys : les données
  sont lues sur le site du service d'eau.

## Configuration

Ouvrez l'écran de configuration de l'intégration et renseignez :

| Champ              | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| **Service d'eau**  | Agur (par défaut), Grand Paris Sud ou Eau de Paris.            |
| **Adresse e-mail** | L'adresse avec laquelle vous vous connectez à l'espace client. |
| **Mot de passe**   | Le mot de passe de l'espace client.                            |

Cliquez ensuite sur **Tester la connexion**. En cas de succès, le bouton
répond par exemple `Connecté à Agur : 1 contrat(s) trouvé(s).` ; sinon, il
affiche l'un des messages décrits dans la partie « Dépannage » ci-dessous.

## Les appareils

Dès que la connexion fonctionne, chaque contrat du compte apparaît dans
l'onglet **Découverte** de l'intégration, sans avoir à lancer de recherche,
sous le nom du service d'eau suivi du numéro du compteur (par exemple
`Agur I21FA123456`). Créez ceux que vous voulez suivre. Leurs fonctionnalités
sont affichées sous leur nom anglais :

| Fonctionnalité                         | Unité | Description                                                                                                                                                                              |
| -------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Meter index**                        | m³    | L'index du compteur au dernier relevé.                                                                                                                                                   |
| **Consumption since previous reading** | m³    | L'eau consommée entre le dernier relevé et le précédent, telle que facturée.                                                                                                             |
| **Average daily consumption**          | L     | La consommation moyenne par jour sur cette même période, calculée par le service d'eau. Les périodes n'ayant pas toutes la même durée, c'est la valeur à comparer d'un relevé à l'autre. |
| **Invoice amount**                     | €     | Le montant TTC de la dernière facture (négatif pour un avoir).                                                                                                                           |
| **Amount due**                         | €     | Ce qu'il reste à payer sur le contrat : positif s'il reste une somme à régler, négatif si le compte est en votre faveur, 0 s'il est soldé.                                               |

L'appareil indique aussi le numéro de contrat, le numéro du compteur et
l'adresse de livraison dans ses paramètres.

### Historique

À la création de l'appareil, l'intégration envoie à Gladys **tout l'historique
disponible** sur l'espace client (relevés et factures), chacun à sa date réelle :
les graphiques montrent donc l'évolution passée dès le premier jour. Un
historique très long est envoyé en plusieurs minutes, pour respecter la limite
de Gladys de 300 valeurs par minute.

### Fréquence de mise à jour

Les relevés sont ceux que le service d'eau utilise pour la **facturation** :
en général un tous les six mois environ, selon votre contrat. Les valeurs
affichées sont celles du **dernier relevé** et non une consommation en temps
réel ; elles changent à chaque nouveau relevé ou nouvelle facture.
L'intégration interroge l'espace client toutes les 6 heures, et 30 minutes après
un échec.

## Dépannage

Les messages d'erreur s'affichent dans l'état de connexion de l'intégration et
sous le bouton **Tester la connexion**.

**« Saisissez l'adresse e-mail et le mot de passe de votre compte eau dans la
configuration. »** Renseignez les deux champs, puis enregistrez.

**« Agur a refusé l'adresse e-mail ou le mot de passe (…). »** Le message
entre parenthèses est l'explication donnée par le service d'eau. Vérifiez vos
identifiants en vous connectant sur son site ; si le site vous demande de
changer de mot de passe, faites-le puis saisissez le nouveau dans Gladys. Pour
ne pas risquer le blocage de votre compte, l'intégration **suspend ses mises à
jour** après un refus : elles reprennent quand vous enregistrez la
configuration ou cliquez sur **Tester la connexion**.

**« Agur n'a pas répondu à temps », « Agur a répondu par une erreur (HTTP …) »
ou « Agur a envoyé une réponse inattendue ».** Le site du service d'eau est lent
ou en maintenance. L'intégration réessaie toute seule ; si cela dure plusieurs
jours, consultez les journaux de l'intégration et signalez le problème.

**« Agur est injoignable. »** Vérifiez la connexion internet de la machine qui
fait tourner Gladys.

**Un contrat n'apparaît pas dans l'onglet Découverte.** Vérifiez qu'il est
visible sur l'espace client avec le même compte, puis cliquez sur **Tester la
connexion** : la liste des appareils est mise à jour juste après.

## Confidentialité

L'adresse e-mail et le mot de passe sont stockés par Gladys (le mot de passe
comme un secret) et ne sont envoyés qu'au site de votre service d'eau.
L'intégration ne communique avec rien d'autre.

Cette intégration n'est pas affiliée à Agur, Grand Paris Sud ou Eau de Paris.
Elle utilise l'interface de leur espace client, qui peut changer sans préavis.
