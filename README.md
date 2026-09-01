# Zanocuj Map

Mapa pokazuje obszary programu **Zanocuj w lesie** (Lasy Państwowe) i punkty
infrastruktury z dwóch niezależnych baz:

1. **BDL / Lasy Państwowe** - oficjalny Bank Danych o Lasach
2. **OpenStreetMap** - przez Overpass API

Punkty z obu baz są pokazywane **równolegle i osobno**. Jeśli BDL i OSM opisują
to samo miejsce, oba markery zostają na mapie i rozsuwają się, żeby każdy dał
się kliknąć.

## Markery

- zielone kółko z etykietą **LP** - punkt z Banku Danych o Lasach
- niebieski kwadrat z etykietą **OSM** - punkt z OpenStreetMap
- zielona obwódka - punkt leży wewnątrz obszaru Zanocuj w lesie

W popupie widać źródło, surowe tagi OSM i informację, czy punkt jest wewnątrz
obszaru Zanocuj w lesie.

## Filtry

- typy obiektów (wiaty, paleniska, miejsca wypoczynku, woda, toalety, biwak,
  parking, punkty widokowe)
- źródło danych (BDL / OSM) niezależnie
- **Tylko wewnątrz obszarów Zanocuj w lesie** - domyślnie wyłączone, bo dane OSM
  nie są przypisane do granic programu i taki filtr odcina większość punktów
- **Ukryj wiaty przystankowe (OSM)** - domyślnie wyłączone, żeby wynik zgadzał
  się 1:1 z overpass-turbo

## Zapytanie Overpass

Dokładnie to, które działa w overpass-turbo:

```
[out:json][timeout:25];
(
  nwr["amenity"="shelter"]({{bbox}});
  nwr["tourism"="picnic_site"]({{bbox}});
  nwr["leisure"="firepit"]({{bbox}});
);
out center;
```

Kolejność serwerów: `overpass-api.de`, `overpass.kumi.systems`,
`overpass.private.coffee`, a na końcu własne proxy `/api/osm`. Serwer, który
odpowiedział jako pierwszy, zapamiętywany jest w `localStorage` i przy kolejnych
zapytaniach próbowany jako pierwszy.

## Warstwy BDL

- 0 - obszary Zanocuj w lesie (poligony)
- 5 - schroniska leśne
- 6 - miejsca biwakowania
- 15 - miejsca wypoczynku (pola `wiata`, `lawostoly`, `palenisko`, `parking`,
  `toalety_tm`, `toalety_st`, `woda_pitna`, `kuchenka`)
- 17 - parkingi leśne
- 19 - miejsca postoju pojazdów
- 25 - punkty widokowe
- 27 - inne punktowe obiekty rekreacyjne

## Wydajność

- dane pobierane są dla widoku powiększonego o 35% marginesu, więc drobne
  przesunięcia mapy obsługuje pamięć podręczna, bez ruchu sieciowego
- odpowiedzi są cache'owane w przeglądarce na 10 minut
- strefy, punkty BDL i OSM lecą równolegle i rysują się w miarę napływania
- poprzednie żądania są anulowane (`AbortController`), gdy mapa zmieni widok
- każde żądanie ma własny limit czasu; funkcje serverless odpowiadają w budżecie
  ~9 s, żeby zamiast platformowego 504 wrócił czytelny błąd JSON

## Widok w adresie URL

Pozycja mapy zapisuje się w adresie jako `#zoom/lat/lon`, np.
`#12/52.30000/21.00000` - link i odświeżenie strony zachowują widok.

## Zoom

- zoom 8+ - obszary Zanocuj w lesie
- zoom 10+ - punkty BDL i OSM

## Deploy

Vercel podpięty bezpośrednio do repozytorium. Po pushu na `main` robi redeploy
automatycznie. Nie są potrzebne klucze API ani zmienne środowiskowe.
