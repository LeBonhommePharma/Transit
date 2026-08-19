# Rive

Atlas public pour le **RTC** et la **STLévis** à Québec, la **STM**, la **STL** à Laval et le **RTL** à Longueuil, la **STS** à Sherbrooke et la **STTR** à Trois-Rivières. Carte, trajectoires, et surtout **l'horaire d'un arrêt où tu n'es pas**. Gratuit. Pas d'abonnement.

Logiciel sous **Apache License 2.0**. Voir `LICENSE` et `NOTICE`.

Ouvre `/Transit` pour l'atlas autonome. Un champ, un arrêt, les prochaines heures. Pas besoin d'être sur le quai.

Les horaires viennent des flux GTFS officiels:

- RTC: [données ouvertes](https://www.rtcquebec.ca/donnees-ouvertes)
- STLévis: [données ouvertes](https://www.stlevis.ca/stlevis/donnees-ouvertes)
- STM: [développeurs](https://www.stm.info/fr/a-propos/developpeurs)
- STL Laval: [données ouvertes](https://stlaval.ca/affaires/donnees-ouvertes)
- RTL Longueuil: [données ouvertes](https://www.rtl-longueuil.qc.ca/donnees-ouvertes)
- STS Sherbrooke: [données ouvertes](https://www.sts.qc.ca/a-propos/la-sts/donnees-ouvertes/)
- STTR Trois-Rivières: [Données Québec](https://www.donneesquebec.ca/recherche/dataset/gtsf)

## Lancer

```bash
npm install
npm run ingest
npm run dev
```

`ingest` lit `src/lib/registry.json`, télécharge les zips officiels, et écrit `public/data/<ville>`. `npm run ingest -- --city sherbrooke` ne reconstruit qu'une ville. Relance-le quand les agences publient une nouvelle grille. Un flux dont le calendrier est déjà fini est refusé.

## Ce qui est lié

1. Arrêts et stations (`stops`)
2. Parcours et couleurs officielles (`routes`)
3. Tracés GPS (`shapes`) dessinés sur la carte
4. Horaires du jour (`stop_times` + `calendar` / `calendar_dates`)

Un clic sur un arrêt ouvre les prochains passages. De / Vers construit un trajet marche + bus ou métro, avec un changement si besoin.

Québec joint RTC et STLévis. Montréal joint STM, STL Laval et RTL Longueuil. Sherbrooke et Trois-Rivières ont chacun leur atlas. exo, REM et le corridor interurbain viennent après.

## Licence des données

L'application intègre les Informations publiques du Réseau de transport de la Capitale. La STM, la STLévis, la STL, le RTL, la STS et la STTR conservent les droits sur leurs horaires. Aucune n'endosse ce projet.
