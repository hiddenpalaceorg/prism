"""Tests for _nullify (prism_adapter.cli).

_nullify normalizes header/volume/SFO metadata fields to a clean string or None.
The consumer's schema types these fields as strings, so _nullify must coerce the
non-string values ps2exe occasionally returns (notably the integer SFO
parental_level) rather than passing them through — see the regression below.
"""

from prism_adapter.cli import _nullify


def test_strings_are_stripped_and_emptied_to_none():
    assert _nullify("  BESLES-12345  ") == "BESLES-12345"
    assert _nullify("") is None
    assert _nullify("   ") is None
    # C0 control bytes and DEL are stripped (NUL cannot reach Postgres jsonb).
    assert _nullify("AB\x00\x07C\x7f") == "ABC"


def test_none_stays_none():
    assert _nullify(None) is None


def test_integer_is_coerced_to_string():
    # Regression: SFO parental_level arrives as an int; the consumer expects a
    # string, so a bare integer broke adapter-output deserialization. Coerce it.
    assert _nullify(0) == "0"
    assert _nullify(5) == "5"
    assert _nullify(101) == "101"


def test_non_string_scalars_are_coerced():
    assert _nullify(1.5) == "1.5"
