# Zanocuj Map v3

Ta wersja pokazuje infrastrukturę z dwóch niezależnych źródeł:

1. BDL / Lasy Państwowe
2. OpenStreetMap / Overpass

## Co zostało poprawione

Poprzednia wersja pobierała z BDL tylko poligony "Zanocuj w lesie", a markerów
wiat, palenisk itd. szukała wyłącznie w OSM.

W v3 pobierane są również oficjalne punktowe warstwy BDL:

- 5 - schroniska leśne
- 6 - miejsca biwakowania
- 15 - miejsca wypoczynku
- 17 - parkingi leśne
- 19 - miejsca postoju pojazdów
- 25 - punkty widokowe
- 27 - inne punktowe obiekty rekreacyjne

Warstwa 15 zawiera m.in. pola:

- wiata
- lawostoly
- palenisko
- parking
- toalety_tm
- toalety_st
- woda_pitna
- kuchenka

Punkty BDL oraz OSM są następnie filtrowane przez granice programu
"Zanocuj w lesie".

## Markery

Marker ma małą etykietę:

- `LP` - oficjalny punkt z Banku Danych o Lasach
- `OSM` - punkt z OpenStreetMap

Źródła można niezależnie włączać i wyłączać.

## Deploy

Vercel może być podpięty bezpośrednio do tego repozytorium. Po każdym pushu na `main` zrobi redeploy automatycznie.

Nie są potrzebne żadne klucze API ani Environment Variables.
