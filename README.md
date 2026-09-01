# Zanocuj Map v2

Wersja poprawiona pod Vercel.

## Najważniejsza zmiana

Aplikacja nie pobiera już wszystkich poligonów programu z całej Polski przez jedną funkcję Vercela.

Zamiast tego:
1. od zoomu 8 pobiera z BDL tylko poligony przecinające aktualny widok mapy,
2. od zoomu 11 pobiera POI z Overpass,
3. Turf.js zostawia tylko POI znajdujące się wewnątrz pobranych poligonów.

To znacząco zmniejsza odpowiedzi funkcji Vercela.

## Źródło BDL

Używana jest aktualna warstwa:

`Czas_w_las/WFS_BDL_czas_w_las/MapServer/0`

czyli:
`Obszar programu Zanocuj w Lesie - ob. powierzchniowy`

Warstwa ma również pola m.in.:
- wiata
- lawostoly
- palenisko
- toalety_tm
- kuchenka

Te informacje są pokazane w popupie obszaru, gdy BDL oznaczy je jako dostępne.

## Lokalnie

```bash
npm install
npm run dev
```

## Vercel

Zaimportuj repo.

```text
Framework Preset: Vite
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

Environment Variables: brak.

## Aktualizacja istniejącego projektu

Możesz po prostu zastąpić pliki w dotychczasowym repo plikami z tej wersji i zrobić:

```bash
git add .
git commit -m "Fix BDL loading"
git push
```

Vercel zrobi redeploy automatycznie.
