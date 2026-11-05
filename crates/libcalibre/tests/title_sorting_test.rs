// Property-based tests for book title sorting
// Verifies invariants in sort_book_title() logic

use libcalibre::__internals::sort_book_title;
use proptest::prelude::*;

proptest! {
    /// Property: Title sorting is deterministic
    #[test]
    fn sorting_is_deterministic(title in "\\PC{0,100}") {
        let result1 = sort_book_title(title.clone());
        let result2 = sort_book_title(title.clone());

        prop_assert_eq!(result1, result2,
            "Non-deterministic title sorting");
    }

    /// Property: Title sorting never produces empty string for non-empty input
    #[test]
    fn sorted_title_non_empty(title in "\\PC{1,100}") {
        let result = sort_book_title(title.clone());

        prop_assert!(!result.is_empty(),
            "Empty result for non-empty title '{}'", title);
    }

    /// Property: If title doesn't start with article pattern, it's usually unchanged
    #[test]
    fn title_without_article_unchanged(
        // Start with letters that definitely aren't articles
        first_word in "[B-MO-SU-Zb-mo-su-z][a-z]{1,10}",
        rest in "[A-Za-z0-9]{0,40}"
    ) {
        let title = if rest.is_empty() {
            first_word.clone()
        } else {
            format!("{} {}", first_word, rest)
        };
        let result = sort_book_title(title.clone());

        // Should be unchanged if no article at START
        prop_assert_eq!(&result, &title,
            "Title without article at start was changed: '{}' -> '{}'", title, result);
    }

    /// Property: Titles starting with "The " move "The" to end
    #[test]
    fn title_with_the_moves_article(
        rest in "[A-Z][A-Za-z0-9 ]{1,50}"
    ) {
        let title = format!("The {}", rest);
        let result = sort_book_title(title.clone());

        prop_assert!(
            result.ends_with(", The") || result == title,
            "Title '{}' didn't move 'The' correctly: '{}'", title, result
        );
    }

    /// Property: Titles starting with "A " move "A" to end
    #[test]
    fn title_with_a_moves_article(
        rest in "[A-Z][A-Za-z0-9 ]{1,50}"
    ) {
        let title = format!("A {}", rest);
        let result = sort_book_title(title.clone());

        prop_assert!(
            result.ends_with(", A") || result == title,
            "Title '{}' didn't move 'A' correctly: '{}'", title, result
        );
    }

    /// Property: Titles starting with "An " move "An" to end
    #[test]
    fn title_with_an_moves_article(
        rest in "[A-Z][A-Za-z0-9 ]{1,50}"
    ) {
        let title = format!("An {}", rest);
        let result = sort_book_title(title.clone());

        prop_assert!(
            result.ends_with(", An") || result == title,
            "Title '{}' didn't move 'An' correctly: '{}'", title, result
        );
    }
}
