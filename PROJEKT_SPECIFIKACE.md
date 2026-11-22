# Technická specifikace projektu: ApexNotes
**Autonomní digitální rally navigátor (PWA & Geometrický algoritmus)**
**Autor:** Michael Dluhoš

---

## 1. Popis problému a cíl projektu
Amatérští automobiloví závodníci (rallysprinty, závody do vrchu, trackdays) a sportovní řidiči často jezdí bez stálého spolujezdce. Ruční příprava rozpisu (*pacenotes*) vyžaduje hodiny pomalého projíždění trati a běžné navigace (Waze, Google Maps) nehlásí ostrost zatáček, utahování ani slepé horizonty v závodním tempu.

**Cíl projektu (90% MVP do konce ledna 2027):**
Vyvinout autonomní digitální rally navigátor **ApexNotes**, který z GPX trasy a výškových dat automaticky vypočítá geometrii zatáček i horizontů, převede je do českého rally slangu (stupnice 1–6) a prostřednictvím mobilní PWA aplikace (optimalizované pro iOS / iPhone 13 i Android s offline režimem) je s dynamickým předstihem podle aktuální rychlosti hlasově čte řidiči.

---

## 2. Architektura systému
Systém je rozdělen do dvou hlavních modulů podle harmonogramu:

1. **Analytický a geometrický engine (Python – Fáze 2):**
   - Načítá surové GPX/KML soubory tratí.
   - Provádí převod GPS souřadnic $(\text{lat}, \text{lon})$ do lokální metrické soustavy $(x, y)$ v metrech.
   - Interpoluje a vyhlazuje trasu pomocí **Catmull-Rom spline** filtru s rovnoměrným vzorkováním po $2{,}5\text{ m}$.
   - Vypočítává **Mengerovu křivost** $\kappa$ a poloměr zatáčky $R = 1/\kappa$ ze tří po sobě jdoucích bodů a pomocí 2D vektorového součinu (cross product) určuje směr (**Levá / Pravá**).
   - Analyzuje výškový profil (DEM / nadmořskou výšku $z$), počítá podélný sklon vozovky v $\%$ a jeho druhou derivaci (změnu sklonu) pro detekci **slepých horizontů** a prudkých klesání/stoupání.
   - Seskupuje body do souvislých zatáček, rozpoznává **utahování / otevírání** zatáčky, měří délky rovinek mezi zatáčkami a generuje strukturovaný JSON rozpis a čitelný textový rozpis.

2. **Mobilní klientská aplikace (Offline PWA – Fáze 3 & 4):**
   - Běží přímo na mobilním telefonu (**iPhone 13** přes Safari *Přidat na plochu* jako plnohodnotná fullscreen aplikace, i Android) bez nutnosti připojení k internetu (*Service Worker* + *Web App Manifest*).
   - Obsahuje vestavěný geometrický parser (umožňuje nahrát libovolný GPX soubor i přímo v telefonu offline) a předpřipravené české RZ.
   - Využívá GPS senzor telefonu (`navigator.geolocation.watchPosition`) nebo testovací jízdní simulátor.
   - **Prediktivní telemetrie:** Čte hlášky s dynamickým časovým předstihem $\Delta t \approx 3{,}0\text{ až }4{,}5\text{ s}$ úměrným okamžité rychlosti vozidla ($d_{\text{předstih}} = v \cdot \Delta t$).
   - **Audio banka:** Přehrává čisté české hlasové povely (MP3/WAV vzorky + syntéza hlasu) a zobrazuje vysokokontrastní závodní UI pro čitelnost z držáku v autě.
   - **Freemium modul:** Počítadlo odjetých kilometrů (limit 40 km zdarma, poté odemčení plné verze za 300 Kč).

---

## 3. Standard českého rally hlášení (Stupnice 1–6)

Použitá stupnice odpovídá nejrozšířenějšímu českému rally standardu, kde **1 = nejostřejší zatáčka (vracák)** a **6 = nejrychlejší mírná zatáčka**:

| Stupeň | Poloměr $R$ (m) | Typ zatáčky | Orientační rychlost | Hlasový povel (Levá / Pravá) |
| :--- | :--- | :--- | :--- | :--- |
| **1** | $R < 18\text{ m}$ | Vracák / velmi ostrá (hairpin) | $25 - 40\text{ km/h}$ | *„Levá jedna (vracák)“* / *„Pravá jedna“* |
| **2** | $18 - 32\text{ m}$ | Ostrá zatáčka na 2. převodový stupeň | $40 - 60\text{ km/h}$ | *„Levá dva“* / *„Pravá dva“* |
| **3** | $32 - 55\text{ m}$ | Středně ostrá zatáčka | $60 - 80\text{ km/h}$ | *„Levá tři“* / *„Pravá tři“* |
| **4** | $55 - 90\text{ m}$ | Rychlejší otevřená zatáčka | $80 - 105\text{ km/h}$ | *„Levá čtyři“* / *„Pravá čtyři“* |
| **5** | $90 - 145\text{ m}$ | Velmi rychlá zatáčka | $105 - 130\text{ km/h}$ | *„Levá pět“* / *„Pravá pět“* |
| **6** | $145 - 240\text{ m}$ | Mírný ohyb (téměř plný plyn) | $> 130\text{ km/h}$ | *„Levá šest“* / *„Pravá šest“* |
| **Rovinka** | $R > 240\text{ m}$ | Rovný úsek (zaokrouhleno na desítky m) | Plný plyn | *„Do třicet / padesát / sto / dvě stě“* |

### Doplňkové modifikátory (Český rally slang):
- **„utahuje“** (např. *„Pravá čtyři utahuje do dva“*): Poloměr zatáčky se v druhé polovině oblouku zmenší o alespoň 1 stupeň.
- **„otevírá“**: Poloměr zatáčky se v druhé polovině oblouku zvětší.
- **„dlouhá“**: Délka oblouku zatáčky přesahuje $60\text{ m}$ (nebo úhel zatočení $> 110^\circ$).
- **„přes horizont“ / „pozor horizont“**: Zlom podélného výškového profilu ($\Delta \text{sklon} < -4{,}5\,\%$ na krátkém úseku), přes který řidič nevidí pokračování silnice.
- **„do“**: Navazující zatáčka následuje ve vzdálenosti menší než $25\text{ m}$.
