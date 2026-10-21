"""Made-up text lines for the scanner's text readers (docs/hf-plan.md → H8b, H8c): the passport's
machine-readable zone (ICAO 9303 TD3, every check digit right) and the fields of an Israeli ID card
(Hebrew names, ID numbers with a right check digit, dates, addresses). No real person: the names
are common ones put together at random. Pure — no fonts, no images, so the rules are tested
(tests/auth/test_scan_train_synth.py); synth_lines.py draws them with TRDG.

  lines("mrz", 1000, seed=1)       # → [(text, fields)], line 1 and line 2 of each passport in turn
  lines("he", 1000, seed=1)        # → [(text, {"kind": …})], logical order (right to left as read)
"""
import math
import random

# ---------- the passport's machine-readable zone (TD3: two lines of 44) ----------
MRZ_LEN = 44
MRZ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"
# The passports a firm's workers mostly hold (owner, 2026-10-21: Thai, Indian, Ukrainian, Russian,
# Belarusian, Moldovan, Sri Lankan first), each with its own number and personal number as printed
# (L: a letter, 9: a digit, X: either; a number shorter than 9 is filled with <), and its weight.
PROFILES = {
    "THA": {"w": 14, "number": ("LL9999999", "L999999"), "personal": "9999999999999"},
    "IND": {"w": 14, "number": ("L9999999",), "personal": ""},
    "UKR": {"w": 14, "number": ("LL999999",), "personal": "99999999999999"},
    "RUS": {"w": 14, "number": ("999999999",), "personal": ""},
    "BLR": {"w": 12, "number": ("LL9999999",), "personal": "9999999L999LL9"},
    "MDA": {"w": 12, "number": ("L99999999", "LL9999999"), "personal": "9999999999999"},
    "LKA": {"w": 12, "number": ("L9999999", "LL9999999"), "personal": ("999999999999", "999999999V")},
    "ISR": {"w": 8, "number": ("99999999",), "personal": ""},
}
OTHERS = ("GEO", "UZB", "KAZ", "ROU", "BGR", "PHL", "CHN", "NPL", "ETH", "ERI", "SDN", "TUR", "USA", "FRA", "GBR",
          "D<<", "ARE", "EGY", "JOR", "KGZ", "ARM", "AZE", "VNM", "MMR", "BGD", "PAK")
COUNTRIES = tuple(PROFILES) + OTHERS
# names by where they come from (Latin, as a passport's zone prints them)
NAMES = {
    "thai": (("SOMCHAI", "WONGSAWAT", "SRISUK", "CHAIYAPORN", "SUKSAWAT", "PHROMMA", "THONGDEE", "SAELIM", "BOONMA", "KAEWKLA",
              "JAIDEE", "RATTANAPHON", "SANGTHONG", "PHUMPHUANG"),
             ("SOMSAK", "SOMCHAI", "NARONG", "WICHAI", "KANYA", "MALEE", "SUDARAT", "ANAN", "PRASERT", "SUPAPORN", "NATTAPONG",
              "THANAWAT", "PORNTHIP", "KITTISAK")),
    "india": (("KUMAR", "SINGH", "SHARMA", "PATEL", "YADAV", "REDDY", "NAIR", "GUPTA", "DAS", "PILLAI", "VERMA", "MISHRA",
               "CHAUHAN", "MOHAMMED"),
              ("RAJ", "PRIYA", "RAHUL", "SUNIL", "ANIL", "LAKSHMI", "DEEPAK", "SURESH", "ANITA", "VIJAY", "RAMESH KUMAR",
               "MOHAMMED IRFAN", "SANTOSH", "KAVITHA")),
    "slavic": (("SHEVCHENKO", "KOVALENKO", "BONDARENKO", "TKACHENKO", "IVANOV", "SMIRNOV", "KUZNETSOV", "POPOV", "IVANOVA",
                "NOVIKOVA", "LUKASHEVICH", "KOVALCHUK", "RUSU", "CEBAN", "MUNTEANU", "MELNYK", "KRAVCHUK", "SAVCHENKO"),
               ("OLEKSANDR", "IRYNA", "OKSANA", "DMYTRO", "SERGEI", "OLGA", "ANDREI", "ELENA", "VASYL", "NATALIIA", "YULIIA",
                "ALIAKSANDR", "SIARHEI", "ION", "VASILE", "MIHAIL", "TATSIANA", "MAKSIM")),
    "lanka": (("PERERA", "FERNANDO", "SILVA", "JAYASURIYA", "WICKRAMASINGHE", "BANDARA", "DISSANAYAKE", "RATHNAYAKE",
               "HERATH", "KUMARA", "GUNAWARDENA", "SENANAYAKE", "RAJAPAKSHA", "MUDIYANSELAGE"),
              ("NIMAL", "KAMAL", "SUNIL", "CHAMARI", "DILANI", "PRIYANKA", "SAMAN", "NUWAN", "THARINDU", "ISURU",
               "HETTI ARACHCHIGE NIMAL", "MOHAMED RIZWAN", "SANDYA", "KUMUDU")),
    "israel": (("COHEN", "LEVI", "MIZRAHI", "PERETZ", "BITON", "DAHAN", "AVRAHAM", "FRIEDMAN", "AZOULAY", "MALKA",
                "BEN DAVID", "OHAYON", "GABAY", "SHALOM"),
               ("DAVID", "MOSHE", "NOAM", "OMER", "RUTH", "NOA", "LIAT", "YAEL", "ITAI", "AVI", "TAMAR", "YOSEF", "SHIRA")),
    "other": (("SANTOS", "REYES", "DELA CRUZ", "WANG", "LI", "ZHANG", "TESFAYE", "GEBRE", "YILMAZ", "SMITH", "MARTIN",
               "AL HASHIMI", "ABU SALEH", "KHACHATRYAN", "BERIDZE", "ABDULLAEV", "O NEILL", "VAN DER BERG", "MUELLER",
               "NGUYEN", "TRAN", "HOSSAIN", "KHAN"),
              ("JOSE", "ANA", "WEI", "MEI", "ABEBE", "HANNA", "MEHMET", "JOHN", "ANNE", "KHALED", "FATIMA", "GIORGI",
               "NINO", "ALISHER", "AIGERIM", "JEAN PIERRE", "MARY ANN", "ABDUL RAHMAN", "MINH ANH")),
}
NAME_GROUP = {"THA": "thai", "IND": "india", "UKR": "slavic", "RUS": "slavic", "BLR": "slavic", "MDA": "slavic",
              "LKA": "lanka", "ISR": "israel"}
SURNAMES = tuple(n for g in NAMES.values() for n in g[0])
GIVEN = tuple(n for g in NAMES.values() for n in g[1])


def _pattern(rng, pat):
    return "".join(rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ") if c == "L" else rng.choice("0123456789") if c == "9"
                   else c for c in pat)


def mrz_check(s):
    """ICAO 9303 check digit: weights 7, 3, 1; digits as they are, A-Z = 10-35, < = 0
    (the same as functions-auth/ai.py _mrz_check and src/scan-process/mrz.ts mrzCheck)."""
    t = 0
    for i, c in enumerate(s):
        v = int(c) if c.isdigit() else (ord(c) - 55 if "A" <= c <= "Z" else 0)
        t += v * (7, 3, 1)[i % 3]
    return t % 10


def _name_part(s):
    return s.replace(" ", "<").replace("-", "<")


def _yymmdd(rng, y0, y1):
    y, m = rng.randint(y0, y1), rng.randint(1, 12)
    return y, m, rng.randint(1, 28 if m == 2 else 30)


def td3(rng):
    """A made-up passport's MRZ: (line 1, line 2, the fields) with every check digit right — mostly of
    the countries in PROFILES (by their weight), each with its own number and personal number."""
    if rng.random() < 0.85:
        country = rng.choices(list(PROFILES), [p["w"] for p in PROFILES.values()])[0]
    else:
        country = rng.choice(OTHERS)
    prof = PROFILES.get(country, {"number": ("999999999", "LL9999999", "L99999999"), "personal": ""})
    nat = country if rng.random() < 0.95 else rng.choice(COUNTRIES)
    surs, givs = NAMES[NAME_GROUP.get(country, "other")]
    sur = rng.choice(surs) + ("" if rng.random() < 0.85 else " " + rng.choice(surs))
    giv = rng.choice(givs) + ("" if rng.random() < 0.75 else " " + rng.choice(givs))
    names = _name_part(sur) + "<<" + _name_part(giv)
    line1 = ("P" + rng.choice("<<<<<<NO") + country + names)[:MRZ_LEN].ljust(MRZ_LEN, "<")
    number = _pattern(rng, rng.choice(prof["number"]))[:9].ljust(9, "<")
    by, bm, bd = _yymmdd(rng, 1955, 2007)
    ey, em, ed = _yymmdd(rng, 2018, 2036)
    dob, exp = f"{by % 100:02d}{bm:02d}{bd:02d}", f"{ey % 100:02d}{em:02d}{ed:02d}"
    sex = rng.choice("MMMFF<" if country not in PROFILES else "MMMFF")
    pers = prof["personal"]
    pers = rng.choice(pers) if isinstance(pers, tuple) else pers
    if pers and rng.random() < 0.85:
        personal = _pattern(rng, pers)[:14].ljust(14, "<")
        pchk = str(mrz_check(personal))
    else:
        personal = "<" * 14
        pchk = "<" if rng.random() < 0.6 else "0"
    body = number + str(mrz_check(number)) + nat + dob + str(mrz_check(dob)) + sex + exp + str(mrz_check(exp)) + personal + pchk
    composite = body[0:10] + body[13:20] + body[21:43]
    line2 = body + str(mrz_check(composite))
    assert len(line1) == MRZ_LEN and len(line2) == MRZ_LEN
    fields = {"passportNo": number.rstrip("<"), "dob": f"{bd:02d}/{bm:02d}/{by}", "expiry": f"{ed:02d}/{em:02d}/{ey}",
              "sex": sex if sex in "MF" else "", "surname": sur, "given": giv, "nationality": nat.replace("<", ""),
              "country": country}
    return line1, line2, fields


# ---------- the fields of an Israeli ID card ----------
HE_GIVEN = ("משה", "דוד", "יוסף", "אברהם", "יצחק", "יעקב", "שלמה", "אליהו", "נועם", "עומר", "איתי", "אורי", "יונתן",
            "שרה", "רחל", "לאה", "רבקה", "מרים", "נועה", "יעל", "רות", "ליאת", "מיכל", "תמר", "שירה", "אסתר",
            "אולגה", "אירינה", "סרגיי", "דמיטרי", "אלכסנדר", "יבגני", "ולדימיר", "נטליה", "סבטלנה", "מוחמד", "אחמד")
HE_SURNAMES = ("כהן", "לוי", "מזרחי", "פרץ", "ביטון", "דהן", "אברהם", "פרידמן", "אזולאי", "מלכה", "חדד", "גבאי",
               "שלום", "אוחיון", "יוסף", "דוד", "עמר", "בן דוד", "רבינוביץ", "שפירא", "קוגן", "ברדוגו", "אלמוג",
               "שבצ'נקו", "קובלנקו", "איבנוב", "סמירנוב", "פטרוב", "גולדברג", "רוזנברג", "חורי", "עבאס")
HE_CITIES = ("ירושלים", "תל אביב - יפו", "חיפה", "ראשון לציון", "פתח תקווה", "אשדוד", "נתניה", "באר שבע", "בני ברק",
             "חולון", "רמת גן", "אשקלון", "רחובות", "בת ים", "בית שמש", "כפר סבא", "הרצליה", "חדרה", "מודיעין",
             "נצרת", "לוד", "רמלה", "רעננה", "קריית גת", "עפולה", "אילת", "כרמיאל", "טבריה", "דימונה", "שדרות")
HE_STREETS = ("הרצל", "ז'בוטינסקי", "בן גוריון", "רוטשילד", "ויצמן", "העצמאות", "הנביאים", "יפו", "אלנבי",
              "דיזנגוף", "בגין", "רבין", "הגפן", "הזית", "האלון", "התאנה", "הרימון", "סוקולוב", "ביאליק", "אחד העם",
              "שדרות ירושלים", "דרך השלום", "קרן היסוד", "החשמונאים", "בר כוכבא", "המכבים", "הנשיא", "ההגנה")


def israeli_id(rng):
    """A made-up 9-digit Israeli ID number with a right check digit (src/scan-process/ids.ts isValidIsraeliId)."""
    d = [rng.randint(0, 9) for _ in range(8)]
    s = sum((x * (1 + i % 2)) // 10 + (x * (1 + i % 2)) % 10 for i, x in enumerate(d))
    return "".join(map(str, d)) + str((10 - s % 10) % 10)


def valid_israeli_id(s):
    if len(s) != 9 or not s.isdigit():
        return False
    return sum((int(c) * (1 + i % 2)) // 10 + (int(c) * (1 + i % 2)) % 10 for i, c in enumerate(s)) % 10 == 0


def he_line(rng):
    """One field of an ID card as printed: (text in logical order, its kind)."""
    k = rng.random()
    if k < 0.25:
        return rng.choice(HE_GIVEN) + ("" if rng.random() < 0.8 else " " + rng.choice(HE_GIVEN)), "given"
    if k < 0.45:
        return rng.choice(HE_SURNAMES), "surname"
    if k < 0.6:
        i = israeli_id(rng)
        return (i if rng.random() < 0.5 else f"{i[0]} {i[1:8]} {i[8]}"), "idNo"
    if k < 0.75:
        y, m, d = _yymmdd(rng, 1950, 2036)
        return f"{d:02d}{rng.choice('./')}{m:02d}{rng.choice('./')}{y}", "date"
    if k < 0.9:
        return f"{rng.choice(HE_STREETS)} {rng.randint(1, 180)}" + ("" if rng.random() < 0.7 else f"/{rng.randint(1, 30)}"), "street"
    return rng.choice(HE_CITIES), "city"


def lines(kind, n, seed=0):
    """n made-up lines of a kind ("mrz" or "he"): [(text, info)]."""
    rng = random.Random(seed)
    out = []
    if kind == "mrz":
        while len(out) < n:
            l1, l2, f = td3(rng)
            out += [(l1, {"line": 1, **f}), (l2, {"line": 2, **f})]
        return out[:n]
    if kind == "he":
        for _ in range(n):
            t, k = he_line(rng)
            out.append((t, {"kind": k}))
        return out
    raise ValueError(kind)


# ---------- where a made-up document lies on a made-up photo (synth_docs.py) ----------
# The documents' sides as cut (docfind.RATIOS): an ID card (ID-1), a passport's data page (ID-3);
# the ספח is a folded sheet whose part photographed varies.
DOC_SIDES = {"id_front": (85.6, 54.0), "id_back": (85.6, 54.0), "passport": (125.0, 88.0)}


def order_corners(pts):
    """Four points as the document edges model gives them — top-left, top-right, bottom-right,
    bottom-left of the photo (the page is turned upright later, by its face): clockwise on the
    screen from the one with the smallest x + y."""
    cx, cy = sum(p[0] for p in pts) / 4, sum(p[1] for p in pts) / 4
    cw = sorted(pts, key=lambda p: math.atan2(p[1] - cy, p[0] - cx))   # y down: rising angle = clockwise
    k = min(range(4), key=lambda i: cw[i][0] + cw[i][1])
    return [list(cw[(k + i) % 4]) for i in range(4)]


def _convex(q):
    sg = 0
    for i in range(4):
        a, b, c = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if z == 0 or (sg and (z > 0) != (sg > 0)):
            return False
        sg = z
    return True


def _area(q):
    return abs(sum(q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1] for i in range(4))) / 2


def scene_quad(rng, aspect, W, H, fill=(0.18, 0.8), margin=0.01, tilt=0.09):
    """Where a flat document of the given aspect (width / height) lands on a W×H photo: its corners
    in pixels, in the document's own order (its top-left first, clockwise) — turned mostly by a
    quarter turn and a little, seen at a slant (each corner moved up to `tilt` of its size), filling
    `fill` of the photo, every corner at least `margin` inside. None when no try fits."""
    for _ in range(60):
        area = rng.uniform(*fill) * W * H
        h = math.sqrt(area / aspect)
        w = h * aspect
        a = rng.choice((0, 0, 0, 90, 90, 180, 270)) + rng.gauss(0, 10 if rng.random() < 0.8 else 25)
        ca, sa = math.cos(math.radians(a)), math.sin(math.radians(a))
        cx, cy = rng.uniform(0.3, 0.7) * W, rng.uniform(0.3, 0.7) * H
        q = []
        for x, y in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)):
            x += rng.uniform(-tilt, tilt) * w
            y += rng.uniform(-tilt, tilt) * h
            q.append([cx + x * ca - y * sa, cy + x * sa + y * ca])
        if not _convex(q) or _area(q) < 0.1 * W * H:
            continue
        if all(margin * W <= x <= (1 - margin) * W and margin * H <= y <= (1 - margin) * H for x, y in q):
            return q
    return None


# ---------- a field of an Israeli ID card, its back or a ספח, by its kind (template_vary.py) ----------
HE_MONTHS = ("תשרי", "חשון", "כסלו", "טבת", "שבט", "אדר", "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול")
HE_YEARS = ("התש\"ל", "התשל\"ה", "התש\"מ", "התשמ\"ה", "התשמ\"ט", "התש\"נ", "התשנ\"ו", "התש\"ס", "התשס\"ה", "התש\"ע",
            "התשע\"ה", "התשע\"ט", "התש\"פ", "התשפ\"ג", "התשפ\"ה", "התשפ\"ו", "התשפ\"ח", "התש\"צ", "התשצ\"ה")
HE_DAYS = ("א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ז'", "ח'", "ט'", "י'", "י\"א", "י\"ב", "י\"ג", "י\"ד", "ט\"ו", "ט\"ז",
           "י\"ז", "י\"ח", "י\"ט", "כ'", "כ\"א", "כ\"ב", "כ\"ג", "כ\"ד", "כ\"ה", "כ\"ו", "כ\"ז", "כ\"ח", "כ\"ט", "ל'")
HE_SEX = ("זכר", "נקבה")
HE_MARITAL = ("רווק", "רווקה", "נשוי", "נשואה", "גרוש", "גרושה", "אלמן", "אלמנה")
HE_COUNTRIES = ("ישראל", "ברית המועצות", "אוקראינה", "רוסיה", "בלרוס", "מולדובה", "אתיופיה", "מרוקו", "צרפת",
                "ארצות הברית", "ארגנטינה", "רומניה", "עיראק", "תימן", "גאורגיה", "אוזבקיסטן")
FIELD_KINDS = ("surname", "given", "idNo", "date", "hedate", "sex", "marital", "city", "street", "country", "digits")


def he_date(rng):
    """A Hebrew calendar date as an ID card prints it (made up: day, month and year apart)."""
    return f"{rng.choice(HE_DAYS)} ב{rng.choice(HE_MONTHS)} {rng.choice(HE_YEARS)}"


def field_value(kind, rng, n=None):
    """A made-up value of a field kind (FIELD_KINDS), as printed on the document; digits: n of them."""
    if kind == "surname":
        return rng.choice(HE_SURNAMES)
    if kind == "given":
        return rng.choice(HE_GIVEN) + ("" if rng.random() < 0.85 else " " + rng.choice(HE_GIVEN))
    if kind == "idNo":
        i = israeli_id(rng)
        return f"{i[0]} {i[1:8]} {i[8]}" if rng.random() < 0.85 else i
    if kind == "date":
        y, m, d = _yymmdd(rng, 1950, 2036)
        return f"{d:02d}.{m:02d}.{y}" if rng.random() < 0.85 else f"{d}.{m}.{y}"
    if kind == "hedate":
        return he_date(rng)
    if kind == "sex":
        return rng.choice(HE_SEX)
    if kind == "marital":
        return rng.choice(HE_MARITAL)
    if kind == "city":
        return rng.choice(HE_CITIES)
    if kind == "street":
        return rng.choice(HE_STREETS)
    if kind == "country":
        return rng.choice(HE_COUNTRIES)
    if kind == "digits":
        return "".join(rng.choice("0123456789") for _ in range(n or rng.randint(1, 9)))
    raise ValueError(kind)
