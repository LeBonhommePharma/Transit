# Rive

Atlas public pour le **RTC** et la **STLévis** à Québec, la **STM** à Montréal et la **STL** à Laval. Carte, trajectoires, et surtout **l'horaire d'un arrêt où tu n'es pas**. Gratuit. Pas d'abonnement.

Logiciel sous **Apache License 2.0**. Voir `LICENSE` et `NOTICE`.

Ouvre `/Transit` pour l'atlas autonome. Un champ, un arrêt, les prochaines heures. Pas besoin d'être sur le quai.

Les horaires viennent des flux GTFS officiels:

- RTC: [données ouvertes](https://www.rtcquebec.ca/donnees-ouvertes)
- STLévis: [données ouvertes](https://www.stlevis.ca/stlevis/donnees-ouvertes)
- STM: [développeurs](https://www.stm.info/fr/a-propos/developpeurs)
- STL Laval: [données ouvertes](https://stlaval.ca/affaires/donnees-ouvertes)

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

Québec joint RTC et STLévis. Montréal joint STM et STL Laval. exo, REM et le corridor interurbain viennent après.

## Licence des données

L'application intègre les Informations publiques du Réseau de transport de la Capitale. La STM, la STLévis et la STL conservent les droits sur leurs horaires. Aucune n'endosse ce projet.
