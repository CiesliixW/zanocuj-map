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

## Skąd biorą się dane OSM

Głównym źródłem jest **statyczny zrzut całej Polski** w `public/osm-poland.json`,
serwowany z tej samej domeny co aplikacja. Dzięki temu mapa nie zależy od
dostępności ani limitów publicznych serwerów Overpass, a punkty pojawiają się
natychmiast po wczytaniu pliku.

Zrzut generuje workflow **Zrzut danych OSM** (`.github/workflows/osm-snapshot.yml`),
uruchamiany **ręcznie** z zakładki Actions - wiaty i paleniska zmieniają się na
tyle rzadko, że nie ma sensu odświeżać ich z harmonogramu.

Źródłem jest **gotowy zrzut Polski z Geofabriku**, a nie Overpass. Workflow
pobiera `poland-latest.osm.pbf`, wycina interesujące obiekty przez
`osmium tags-filter`, eksportuje je strumieniem GeoJSON i przepuszcza przez
`scripts/convert-osm-extract.mjs`, który liczy środki geometrii i zapisuje
zwarty plik.

Overpass do tego nie służy: to narzędzie do małych zapytań na żywo. Przy
próbie przejścia całego kraju 66 kaflami lustra odbijają ruch limitami i
przebieg ciągnie się godzinami, kończąc się losowo. Zrzut z Geofabriku to
kilka minut, deterministycznie i bez zależności od cudzych serwerów.

Poprzednie podejście przez Overpass zostało w `scripts/fetch-osm.mjs` jako
zapasowe.

Format jest krotkowy, żeby plik był możliwie mały:
`[lat, lon, typ, wiataPrzystankowa, typOsm, idOsm, nazwa]`.

Jeśli zrzutu nie ma (404), aplikacja awaryjnie odpytuje Overpass na żywo -
opisane niżej.

## Zapytanie Overpass (tryb awaryjny)

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

Kolejność serwerów: `overpass.kumi.systems`, `overpass-api.de`,
`overpass.private.coffee`, a na końcu własne proxy `/api/osm` (jedyna droga,
gdy przeglądarka blokuje bezpośrednie zapytania przez CORS).

Lustra Overpass regularnie padają albo odbijają zapytanie limitem, więc nie
czekamy na każde po kolei: co 3,5 s dokładane jest kolejne **równolegle**, a
liczy się pierwsza poprawna odpowiedź - reszta zostaje anulowana. Serwer, który
wygrał, zapamiętuje się w `localStorage` i następnym razem startuje pierwszy.
Proxy odpytywane jest metodą GET, żeby CDN mógł cache'ować odpowiedź (24 h).

## Wyszukiwarka miejsc

Pole u góry panelu przyjmuje nazwę miasta, gminy czy nadleśnictwa i przenosi
mapę w to miejsce. Podpowiedzi pojawiają się od trzeciego znaku, z odstępem
400 ms, Enter wybiera pierwszy wynik, Escape zamyka listę. Wynik z ramką
granic dostaje `fitBounds`, punktowy - `setView` na zoomie 13.

Geokoderem jest Nominatim, odpytywany **przez własne proxy** `/api/geocode`,
a nie wprost z przeglądarki: Nominatim wymaga nagłówka `User-Agent`
identyfikującego aplikację, którego przeglądarka ustawić nie może, a przy
okazji odpowiedzi cache'ują się na CDN (24 h), co mieści się w limicie jednego
zapytania na sekundę. Wyniki są zawężone do Polski.

## Lista miejsc

Pasek nad mapą ma trzy elementy: **selektor typu** (czego szukać), **selektor
sortowania** i przycisk **Lista** z licznikiem, który rozwija panel z wynikami.
Kliknięcie pozycji przenosi mapę na punkt i otwiera jego dymek.

Selektor typu zawęża **wyłącznie listę**; checkboxy w panelu bocznym decydują o
tym, co jest narysowane na mapie. Lista respektuje jedno i drugie, więc nigdy
nie pokaże punktu, którego na mapie nie ma. Opcje selektora budowane są z tej
samej definicji typów co filtry mapy, żeby nie rozjechały się przy dodaniu
kolejnego typu.

Lista jest z natury ograniczona do obszaru na ekranie - tyle jest wczytane -
więc pozostaje kwestia kolejności. Domyślnie sortuje się **po odległości od
środka mapy**: środek to miejsce, na które użytkownik właśnie patrzy, więc
przesunięcie mapy samo przestawia listę. Drugi tryb liczy odległość **od
lokalizacji użytkownika** (GPS), co ma sens przy planowaniu wyjazdu; przy
odmowie dostępu lista wraca do sortowania od środka mapy i mówi o tym wprost.

Widocznych jest maksymalnie 200 pozycji. Pasek leży nad mapą, więc jego
kliknięcia i scroll są odcinane od Leafletu, żeby nie przechodziły jako
przeciąganie czy zoom.

## Podkłady mapy

Przełącznik w prawym górnym rogu mapy, wybór zapamiętywany w `localStorage`:

- **Mapa** - standardowe kafle OpenStreetMap (domyślne)
- **Satelita** - zdjęcia Esri World Imagery, pokrycie globalne
- **Ortofoto PL** - ortofotomapa Geoportalu (GUGiK), dużo ostrzejsza od zdjęć
  globalnych, ale wyłącznie dla terenu Polski

Na podkładach fotograficznych obszary Zanocuj w lesie dostają jaśniejszy kontur
i lżejsze wypełnienie, żeby teren pozostał czytelny.

## Szlaki i ścieżki

Dwie warstwy liniowe BDL, domyślnie wyłączone (wymagają osobnego pobrania),
widoczne od zoomu 11:

- **35 - Szlaki turystyczne**
- **34 - Ścieżki dydaktyczne** (rysowane linią przerywaną)

Schemat pól tych warstw nie jest udokumentowany, więc pobieramy `outFields=*`,
a dymek składamy z pól, które faktycznie przyszły, pomijając techniczne
(`objectid`, `shape_*`, `globalid`). Jeśli warstwa niesie atrybut z kolorem
znakowania, linia dostaje barwę szlaku (czerwony, niebieski, zielony, żółty,
czarny); w przeciwnym razie kolor domyślny dla warstwy.

Geometria jest upraszczana tym mocniej, im dalej jesteśmy - inaczej payload
linii rośnie do megabajtów.

## Warstwy BDL

Schematy pól warstw nie są udokumentowane, a ArcGIS odrzuca **całe** zapytanie,
gdy w `outFields` znajdzie pole, którego warstwa nie ma. Nieudane pobranie jest
więc raz ponawiane z `outFields=*`, zamiast tracić warstwę. Punkt z warstwy bez
flag udogodnień nadal trafia na mapę, z nazwą warstwy w dymku.

Pod filtr **Miejsca biwakowe** wpadają cztery warstwy (6, 8, 10, 12), więc dymek
podaje nazwę konkretnej warstwy - „Kemping", „Pole biwakowe" - zamiast ogólnego
„Miejsca biwakowe". Punkty wyprowadzone z flag udogodnień (palenisko przy
miejscu wypoczynku) opisują samo udogodnienie, a nie warstwę źródłową.


- 0 - obszary Zanocuj w lesie (poligony)
- 5 - schroniska leśne
- 6 - miejsca biwakowania
- 8 - pola biwakowe
- 10 - kempingi
- 12 - obozowiska harcerskie
- 15 - miejsca wypoczynku (pola `wiata`, `lawostoly`, `palenisko`, `parking`,
  `toalety_tm`, `toalety_st`, `woda_pitna`, `kuchenka`)
- 17 - parkingi leśne
- 19 - miejsca postoju pojazdów
- 25 - punkty widokowe
- 27 - inne punktowe obiekty rekreacyjne (inny schemat niż 15, pobierana
  z `outFields=*`)
- 34 - ścieżki dydaktyczne (linie)
- 35 - szlaki turystyczne (linie)

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

Margines pobierania zwęża się automatycznie przy dużym widoku, tak żeby bbox dla
Overpass mieścił się w rozsądnym budżecie. Zapytanie jest odrzucane dopiero, gdy
sam widok przekracza 25 deg2, co przy zoomie 10+ nie zdarza się na żadnym
realnym ekranie.

## Deploy

Vercel podpięty bezpośrednio do repozytorium. Po pushu na `main` robi redeploy
automatycznie. Nie są potrzebne klucze API ani zmienne środowiskowe.
