import unittest

from src.assets import plan_cuts
from src.subtitles import Word, align_to_script, ass_time, build_ass, group_words, hex_to_ass, SubtitleStyle
from src.video_engine import frames_per_shot


def w(text, start, end):
    return Word(text, start, end)


class SubtitleTests(unittest.TestCase):
    def test_hex_to_ass(self):
        self.assertEqual(hex_to_ass("#FFE600"), "&H0000E6FF")
        self.assertEqual(hex_to_ass("#39FF14", 0x80), "&H8014FF39")

    def test_ass_time(self):
        self.assertEqual(ass_time(0), "0:00:00.00")
        self.assertEqual(ass_time(61.234), "0:01:01.23")
        self.assertEqual(ass_time(3725.5), "1:02:05.50")

    def test_group_words(self):
        words = [w("Et", 0, .2), w("si", .2, .4), w("tout", .4, .6), w("était", .6, .9),
                 w("faux", .9, 1.2), w("?", 1.2, 1.25), w("Personne", 2.0, 2.4), w("ne", 2.4, 2.5)]
        chunks = [" ".join(x.text for x in c) for c in group_words(words, SubtitleStyle())]
        self.assertEqual(chunks, ["Et si tout", "était faux ?", "Personne ne"])

    def test_build_ass_contiguous_events(self):
        ass = build_ass([w("Bonjour", .1, .5), w("à", .6, .7), w("tous.", .8, 1.2)])
        events = [l for l in ass.splitlines() if l.startswith("Dialogue:")]
        self.assertEqual(len(events), 3)
        self.assertIn("0:00:00.10,0:00:00.60", events[0])
        self.assertIn("0:00:00.60,0:00:00.80", events[1])
        self.assertIn("0:00:00.80,0:00:01.45", events[2])
        self.assertRegex(events[0], r"\\c&H0000E6FF.*\}BONJOUR\{")
        self.assertIn("}TOUS{", events[2])


class AlignmentTests(unittest.TestCase):
    def test_keeps_script_spelling_and_whisper_timing(self):
        script = "En 1934, John Dillinger s'évade."
        whisper = [w("En", 0, .2), w("1934", .2, .9), w("John", 1, 1.2), w("Dillinjer", 1.2, 1.8),
                   w("s'évade", 1.9, 2.4)]
        out = align_to_script(script, whisper)
        self.assertEqual([x.text for x in out], ["En", "1934,", "John", "Dillinger", "s'évade."])
        self.assertEqual((out[3].start, out[3].end), (1.2, 1.8))
        self.assertEqual(out[4].start, 1.9)

    def test_missing_and_extra_words(self):
        script = "Il ouvre la porte lentement."
        whisper = [w("Il", 0, .2), w("euh", .2, .4), w("ouvre", .4, .7), w("porte", 1.0, 1.3),
                   w("lentement", 1.3, 1.9)]
        out = align_to_script(script, whisper)
        self.assertEqual([x.text for x in out], ["Il", "ouvre", "la", "porte", "lentement."])
        la = out[2]
        self.assertTrue(.7 <= la.start < la.end <= 1.0 + 1e-9)
        starts = [x.start for x in out]
        self.assertEqual(starts, sorted(starts))


class TimingTests(unittest.TestCase):
    def test_frames_no_drift(self):
        self.assertEqual(sum(frames_per_shot([1.01] * 3)), round(3.03 * 30))

    def test_plan_cuts_snap_to_words(self):
        words = [w(str(i), i * 0.5, i * 0.5 + 0.4) for i in range(40)]
        cuts = plan_cuts(words, 20.0)
        self.assertEqual(cuts[0][0], 0.0)
        self.assertEqual(cuts[-1][1], 20.0)
        starts = {x.start for x in words}
        for a, b in cuts[1:]:
            self.assertIn(a, starts)
        self.assertTrue(all(b - a >= 2.0 for a, b in cuts))


if __name__ == "__main__":
    unittest.main()
