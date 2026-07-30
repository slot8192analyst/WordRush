import json
import re
from bs4 import BeautifulSoup

SRC = "高校の英単語一覧まとめ2405語.html"
DST = "senior_words.json"
MODE_KEY = "senior"      # words.json に入れるモードID
MIN_LEN = 4

with open(SRC, encoding="utf-8") as f:
    soup = BeautifulSoup(f, "html.parser")

out = []
seen = set()
skipped = 0

# 高校版は table.tangotable の各行に .eng と .jap がある
for tr in soup.select("table.tangotable tr"):
    en_el = tr.select_one(".eng")
    ja_el = tr.select_one(".jap")
    if not en_el or not ja_el:
        continue

    en = en_el.get_text(strip=True).lower()
    ja = ja_el.get_text(strip=True)

    # アナグラム向け：小文字アルファベットのみ・4文字以上・重複なし
    # （空白/ハイフン/大文字混じり＝熟語・複合語・固有名詞を除外）
    if not re.fullmatch(r"[a-z]+", en):
        skipped += 1
        continue
    if len(en) < MIN_LEN:
        continue
    if en in seen:
        continue

    seen.add(en)
    out.append({"en": en, "ja": ja})

with open(DST, "w", encoding="utf-8") as f:
    json.dump({MODE_KEY: out}, f, ensure_ascii=False, indent=2)

print(f"採用: {len(out)} 語 / 除外(熟語・複合語など): {skipped} 件 → {DST}")
