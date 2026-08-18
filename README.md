# Rive

Atlas public pour le **RTC à Québec** et la **STM à Montréal**. Carte, trajectoires, et surtout **l'horaire d'un arrêt où tu n'es pas**. Gratuit. Pas d'abonnement.

Logiciel sous **Apache License 2.0**. Voir `LICENSE` et `NOTICE`.

Ouvre `/Transit` pour l'atlas autonome. Un champ, un arrêt, les prochaines heures. Pas besoin d'être sur le quai.

Les horaires viennent des flux GTFS officiels:

- RTC: [données ouvertes](https://www.rtcquebec.ca/donnees-ouvertes)
- STM: [développeurs](https://www.stm.info/fr/a-propos/developpeurs)

## Lancer

```bash
npm install
npm run ingest
npm run dev
```

`ingest` télécharge les zips officiels, les compacte, et écrit `public/data/quebec` et `public/data/montreal`. Relance-le quand les agences publient une nouvelle grille.

## Ce qui est lié

1. Arrêts et stations (`stops`)
2. Parcours et couleurs officielles (`routes`)
3. Tracés GPS (`shapes`) dessinés sur la carte
4. Horaires du jour (`stop_times` + `calendar` / `calendar_dates`)

Un clic sur un arrêt ouvre les prochains passages. De / Vers construit un trajet marche + bus ou métro, avec un changement si besoin.

V1 volontairement limitée: Québec (RTC) et Montréal (STM). Lévis, Laval, exo, REM et le corridor interurbain viennent après.

## Licence des données

L'application intègre les Informations publiques du Réseau de transport de la Capitale. La STM conserve les droits sur ses horaires. Aucune des deux n'endosse ce projet.
