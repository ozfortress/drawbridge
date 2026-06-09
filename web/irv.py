"""Instant Runoff Voting calculation for awards."""

from collections import Counter
from typing import List, Tuple


def calculate_irv(votes: List[Tuple[str, str, str]], top_n: int = 3) -> List[Tuple[str, int]]:
    """
    Calculate IRV results from a list of (1st, 2nd, 3rd) preference votes.

    Args:
        votes: List of tuples (choice_1, choice_2, choice_3) — empty strings treated as no preference.
        top_n: Number of places to calculate (default 3).

    Returns:
        List of (candidate, points) sorted by placement (1st = highest points).

    The points system: 1st preference = 3 points, 2nd = 2, 3rd = 1.
    Candidates are ranked by total points. Ties broken by count of 1st preferences.
    """
    scores: dict[str, int] = Counter()
    first_prefs: dict[str, int] = Counter()

    for c1, c2, c3 in votes:
        if c1:
            scores[c1] += 3
            first_prefs[c1] += 1
        if c2:
            scores[c2] += 2
        if c3:
            scores[c3] += 1

    candidates = list(scores.keys())

    def sort_key(candidate: str) -> Tuple[int, int, str]:
        return (-scores[candidate], -first_prefs.get(candidate, 0), candidate)

    candidates.sort(key=sort_key)

    result = []
    for i, candidate in enumerate(candidates[:top_n]):
        result.append((candidate, scores[candidate]))

    return result


def calculate_irv_runoff(votes: List[Tuple[str, str, str]], top_n: int = 3) -> List[Tuple[str, int]]:
    """
    Full instant-runoff (single-seat) elimination to find top_n winners.

    For each round:
      1. Count only 1st-choice votes among remaining candidates.
      2. If a candidate has >50% they win that round and are removed.
      3. Otherwise, eliminate the candidate with fewest 1st-choice votes.
      4. Redistribute eliminated votes to their next available preference.
      5. Repeat until winner found, then remove and continue for next place.

    Returns:
        List of (candidate, final_round_votes) for top_n places.
    """
    # Determine all unique candidates across all votes
    all_candidates: set[str] = set()
    for c1, c2, c3 in votes:
        if c1:
            all_candidates.add(c1)
        if c2:
            all_candidates.add(c2)
        if c3:
            all_candidates.add(c3)

    remaining = set(all_candidates)
    winners: List[Tuple[str, int]] = []

    for place in range(top_n):
        if not remaining:
            break

        # Get current active votes (filtered to remaining candidates)
        active_votes = []
        for c1, c2, c3 in votes:
            for pref in (c1, c2, c3):
                if pref and pref in remaining:
                    active_votes.append(pref)
                    break

        if not active_votes:
            break

        total = len(active_votes)

        while True:
            counts: dict[str, int] = Counter()
            for c1, c2, c3 in votes:
                for pref in (c1, c2, c3):
                    if pref and pref in remaining:
                        counts[pref] += 1
                        break

            if not counts:
                break

            sorted_counts = counts.most_common()

            # Check if top candidate has >50%
            top_candidate, top_count = sorted_counts[0]
            if top_count > total / 2 or len(sorted_counts) == 1:
                winners.append((top_candidate, top_count))
                remaining.discard(top_candidate)
                break

            # Eliminate lowest candidate
            lowest = sorted_counts[-1][0]
            remaining.discard(lowest)

    return winners
