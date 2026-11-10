"""Sanity checks on the evaluation data itself: a wrong expected phrase silently turns a hit into a miss."""

import json
import os
import unittest
from pathlib import Path

from metrics import content_words, mean, normalize, vocabulary_overlap

HERE = Path(__file__).parent
SAMPLES = Path(os.environ.get("SAMPLES_DIR", HERE.parent / "samples" / "docs"))
if not SAMPLES.exists():
    SAMPLES = Path("/samples/docs")  # inside the eval container


def load(name: str) -> list[dict]:
    return [json.loads(line) for line in open(HERE / name) if line.strip()]


def doc(name: str) -> str:
    return (SAMPLES / name).read_text()


class DatasetTest(unittest.TestCase):
    def check_phrases(self, items: list[dict]):
        for item in items:
            if item["expected_doc"] is None:
                self.assertEqual(item["expected_phrases"], [], item["id"])
                continue
            text = normalize(doc(item["expected_doc"]))
            for phrase in item["expected_phrases"]:
                self.assertIn(normalize(phrase), text, f"{item['id']}: {phrase!r} not in {item['expected_doc']}")

    def test_expected_phrases_appear_verbatim_in_their_documents(self):
        for name in ("dataset.jsonl", "dataset-paraphrased.jsonl", "conversations.jsonl"):
            with self.subTest(dataset=name):
                self.check_phrases(load(name))

    def test_ids_are_unique_across_datasets(self):
        ids = [i["id"] for name in ("dataset.jsonl", "dataset-paraphrased.jsonl") for i in load(name)]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_question_has_a_paraphrase_with_the_same_gold_answer(self):
        original = {i["id"]: i for i in load("dataset.jsonl")}
        for para in load("dataset-paraphrased.jsonl"):
            source = original[para["paraphrase_of"]]
            self.assertNotEqual(normalize(para["question"]), normalize(source["question"]))
            for key in ("expected_doc", "expected_phrases", "reference_answer"):
                self.assertEqual(para[key], source[key], f"{para['id']}: {key}")
        self.assertEqual(len(load("dataset-paraphrased.jsonl")), len(original))

    def test_paraphrases_share_much_less_vocabulary_with_the_documents(self):
        def overlap(items):
            return mean([vocabulary_overlap(i["question"], doc(i["expected_doc"])) for i in items if i["expected_doc"]])

        original, paraphrased = overlap(load("dataset.jsonl")), overlap(load("dataset-paraphrased.jsonl"))
        self.assertLess(paraphrased, original - 0.2, f"original {original:.2f} vs paraphrased {paraphrased:.2f}")

    def test_conversation_follow_ups_depend_on_the_earlier_turn(self):
        # A follow-up that names its own subject wouldn't test condensation at all.
        for conv in load("conversations.jsonl"):
            self.assertTrue(conv["turns"], conv["id"])
            self.assertLessEqual(len(content_words(conv["followup"])), 6, conv["id"])


if __name__ == "__main__":
    unittest.main()
