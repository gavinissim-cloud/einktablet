// Sample output so the interface can be tried without the reading engine (DEMO_MODE=1).
export function demoPage() {
  const sample = [
    "בס״ד",
    "שלום לכולם, היום נלמד על ההיסטוריה של ת״א.",
    "העיר נוסדה בשנת 1909 (לפני יותר ממאה שנה) –",
    "והיא היום מרכז תרבותי־כלכלי חשוב.",
    "ד״ר כהן אמר: ״זו עיר שלא נחה לעולם״.",
  ];
  return sample.map((text, i) => ({
    text,
    top: 80 + i * 170,
    bottom: 80 + i * 170 + 130,
    left: 60,
    right: 940,
    unclear: i === 2 ? ["נוסדה"] : [],
  }));
}
