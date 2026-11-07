use std::collections::HashSet;
use std::ops::Not;
use std::sync::LazyLock;

use regex::Regex;

/// Creates a sortable book title by moving a leading article (A, An, The,
/// in any case) to the end after a comma. Articles elsewhere in the title
/// stay put.
///
/// ```
/// use libcalibre::sorting::sort_book_title;
/// assert_eq!(sort_book_title("The Great Gatsby"), "Great Gatsby, The");
/// assert_eq!(sort_book_title("A War of the Worlds"), "War of the Worlds, A");
/// assert_eq!(sort_book_title("Diana The Huntress"), "Diana The Huntress");
/// ```
pub fn sort_book_title(title: &str) -> String {
    static LEADING_ARTICLE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^\s*(a|an|the)\s+").expect("valid pattern"));

    match LEADING_ARTICLE.captures(title) {
        Some(found) => {
            let rest = title[found[0].len()..].trim();
            format!("{rest}, {}", &found[1])
        }
        None => title.to_string(),
    }
}

/// These titles are moved to the end of an author's name when sorting.
static GENERATIONAL_TITLES: [&str; 10] = [
    "Jr.", "Sr.", "Jr", "Sr", "Junior", "Senior", "I", "II", "III", "IV",
];

/// These letters are removed from the end of an author's name when sorting.
static POST_NOMINAL_LETTERS: [&str; 43] = [
    "BA", "B.A", // Bachelor of Arts
    "MA", "M.A", "AM", "A.M.", // Master of Arts
    "BS", "BSc", "B. sc.", "B.sc", "SB", "ScB", // Bachelor of Science
    "MS", "M.S.", "MSc", "M.Sc.", "SM", "S.M.", "ScM", "Sc.M.", // Master of Science
    "PhD", "Ph.D", "DPhil", "D.Phil", // Doctor of Philosophy
    "MD", "M.D", // Doctor of Medicine
    "LLD", "LL.D", // Legum Doctor
    "JD", "J.D", // Juris Doctor
    "DSc", "D.Sc", "ScD", "Sc.D", // Doctor of Science
    "EdD", "Ed.D", "D.Ed", // Doctor of Education
    "EngD", "Eng.D", "D.Eng", "DEng", // Doctor of Engineering
    "Esq", "Esq.", // Esquire
];

/// These words are removed from the beginning of an author's name when sorting.
static PREFIX_TITLE: [&str; 10] = [
    "Mr", "Mrs", "Ms", "Dr", "Prof", "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.",
];

/// If these words occur in an author name, the generated sort string will be
/// identical to the author's name.
static VERBATIM_NAME_INDICATORS: [&str; 17] = [
    "Agency",
    "Corporation",
    "Company",
    "Co.",
    "Council",
    "Committee",
    "Inc.",
    "Institute",
    "National",
    "Society",
    "Club",
    "Team",
    "Software",
    "Games",
    "Entertainment",
    "Media",
    "Studios",
];

// From https://en.wikipedia.org/wiki/List_of_family_name_affixes Jan 22, 2024
static FAMILY_NAME_PREFIXES: [&str; 87] = [
    "A",    // Romanian
    "Ab",   // Welish, Cornish, Breton
    "Af",   // Danish, Swedish,
    "Ap",   // Welsh
    "Av",   // Norwegian
    "Abu",  // Arabic
    "Aït",  // Berber
    "Al",   // Arabic
    "Ālam", // Persian
    "At",
    "Ath", // Berber
    "Bar", // Aramaic
    "Bath",
    "Bat", // Hebrew
    "Ben",
    "Bin",
    "Ibn", // Arabic, Hebre
    "Bet", // Arabic
    "Bint",
    "Binti", // Arabic
    "Binte", // Malaysian
    "Chaudhary",
    "Ch",    // Punjabi
    "Da",    // Italian, Portuguese
    "Das",   // Portuguese
    "De",    // Italian, French, Spanish, Portuguese, Filipino
    "De la", // Spanish
    "Degli", // Italian
    "Del",   // Italian, Spanish
    "Dele",  // Souther French, Spanish, Filipino, Occitan
    "Della", // Italian
    "Der",   // Western Armenian
    "Di",    // Italian
    "Dos",   // Portuguese
    "Du",    // French
    "E",     // Portuguese
    "El",    // Arabic
    "Ferch",
    "Verch", // Welsh
    "Fitz",  // Irish
    "i",     // Catalan
    "ka",    // Zulu
    "Kil",
    "Gil",
    "Mal",
    "Mul", // English, Irish, Scottish
    "La",
    "Le",
    "Lu", // Latin and Roman. I hope you have Roman authors in your library!
    "M'",
    "Mac",
    "Mc",
    "Mck",
    "Mhic",
    "Mic",  // Irish, Scottish, and Manx Gaelic
    "Mala", // Kurdish
    "Na",
    "ณ",   // Thai
    "Ngā", // Te Reo Maori
    "Nic",
    "Ní",  // Irish, Scottish
    "Nin", // Serbian
    "O",
    "Ó",
    "Ua",
    "Uí",   // Irish, Scottish, and Manx Gaelic
    "Öz",   // Turkish
    "Pour", // Persian,
    "'s", // Dutch NOTE: This is likely not supported correctly. I _think_ it's comonly attached to the last name, not separated by a space.
    "Setia",
    "Setya", // Indonesian
    "'t",    // Dutch
    "Te",    // Teo Reo Maori,
    "Ter",   // Dutch, separately Eastern Armenian
    "Tre",   // Cornish
    "Van",   // Dutch
    "Van de",
    "Van Den",
    "Van Der",
    "Van Het",
    "Vant 't", // Dutch
    "Verch",
    "Erch", // Welsh
    "von",  // German
    "war",  // Marathi
    "zu",
    "von und zu", // German
];

/// Returns a lower-cased list of name suffixes, including generational
/// titles and post-nominal letters.
/// Generational titles are in Jr., Jr and Junior forms.
fn gen_name_suffixes() -> Vec<String> {
    let suffixes = GENERATIONAL_TITLES.to_vec();
    suffixes.iter().map(|s| s.to_lowercase()).collect()
}

fn gen_name_prefixes() -> Vec<String> {
    PREFIX_TITLE.iter().map(|s| s.to_lowercase()).collect()
}

/// Removes content within and all sets of parentheses.
fn remove_bracket_content(s: &str) -> String {
    let re = Regex::new(r"[\[\{\(].*?[\]\}\)]").unwrap();
    let result = re.replace_all(s, "");
    result.to_string()
}

fn name_contains_verbatim_name_indicator(name: &str) -> bool {
    let name_lower = name.to_lowercase();
    VERBATIM_NAME_INDICATORS
        .iter()
        .map(|s| s.to_lowercase())
        .collect::<HashSet<String>>()
        .is_disjoint(&HashSet::from_iter(
            name_lower.split_whitespace().map(str::to_string),
        ))
        .not()
}

/// Generate a sortable name for an author in APA style.
///
/// Based on APA style (see https://blog.apastyle.org/apastyle/2012/03/jr-sr-and-other-suffixes-in-apa-style.html,
/// and https://blog.apastyle.org/apastyle/2017/05/whats-in-a-name-names-with-titles-in-them.html)
///
/// Also matches Calibre's `author_to_author_sort` behavior for SQL compatibility.
///
/// ## Examples
/// ```
/// use libcalibre::sorting::sort_author_name_apa;
/// let author = "John Doe";
/// let sortable_name = sort_author_name_apa(author);
/// assert_eq!(sortable_name, "Doe, John");
/// ```
///
/// For Dr.'s and other titles, the title is removed.
/// ```
/// use libcalibre::sorting::sort_author_name_apa;
/// let author = "Dr. John Doe";
/// let sortable_name = sort_author_name_apa(author);
/// assert_eq!(sortable_name, "Doe, John");
/// ```
///
/// For Jr.'s and other generational titles, the title is moved to the end,
/// with a comma before it.
/// ```
/// use libcalibre::sorting::sort_author_name_apa;
/// let author = "John Doe Jr.";
/// let sortable_name = sort_author_name_apa(author);
/// assert_eq!(sortable_name, "Doe, John, Jr.");
/// ```
///
/// Academic degrees, licenses, and professional titles are omitted.
/// ```
/// use libcalibre::sorting::sort_author_name_apa;
/// let author = "John Doe BA Bsc M.S. PhD Esq";
/// let sortable_name = sort_author_name_apa(author);
/// assert_eq!(sortable_name, "Doe, John");
/// ```
///
/// Anything within brackets is removed.
/// ```
/// use libcalibre::sorting::sort_author_name_apa;
/// let author = "John Doe (Author) [Deceased] {Ed.: fictional character}";
/// let sortable_name = sort_author_name_apa(author);
/// assert_eq!(sortable_name, "Doe, John");
/// ```
///
/// Organization names are not modified.
/// ```
/// use libcalibre::sorting::sort_author_name_apa;
/// let author = "Coca Cola Inc.";
/// let sortable_name = sort_author_name_apa(author);
/// assert_eq!(sortable_name, "Coca Cola Inc.");
/// ```
///
/// Surnames with a prefix keep their prefix.
/// ```
/// use libcalibre::sorting::sort_author_name_apa;
/// let author = "Example von Cruz";
/// let sortable_name = sort_author_name_apa(author);
/// assert_eq!(sortable_name, "von Cruz, Example");
/// ```
pub fn sort_author_name_apa(name: &str) -> String {
    // If already in "Last, First" format (contains comma), return as-is
    // This matches Calibre's behavior
    if name.contains(',') {
        return name.to_string();
    }

    let sauthor = remove_bracket_content(name);
    let mut tokens: Vec<String> = sauthor.split_whitespace().map(str::to_string).collect();

    // Short circuits that indicate we need not format at all
    if tokens.len() < 2 || name_contains_verbatim_name_indicator(name) {
        return name.to_string();
    }

    let name_suffixes = gen_name_suffixes();
    let prefixes = gen_name_prefixes();

    let author_surname_prefixes: Vec<String> = FAMILY_NAME_PREFIXES
        .iter()
        .map(|s| s.to_lowercase())
        .collect();
    if tokens.len() == 2 && author_surname_prefixes.contains(&tokens[0].to_lowercase()) {
        return name.to_string();
    }

    // Remove all academic degrees, licenses, and professional titles
    let post_nominal_set: HashSet<String> = POST_NOMINAL_LETTERS
        .iter()
        .map(|s| s.to_lowercase())
        .collect();
    tokens.retain(|token| !post_nominal_set.contains(&token.to_lowercase()));

    let first = tokens
        .iter()
        .position(|token| !prefixes.contains(&token.to_lowercase()))
        .unwrap_or(0);

    let mut last = tokens
        .iter()
        .rposition(|token| !name_suffixes.contains(&token.to_lowercase()))
        .unwrap_or_else(|| tokens.len() - 1);

    let suffix = tokens[(last + 1)..].join(" ");

    // Check for family name prefixes before the last name
    // Try to match multi-word prefixes first (longest match), then single-word
    let author_surname_prefixes_lower: Vec<String> = FAMILY_NAME_PREFIXES
        .iter()
        .map(|s| s.to_lowercase())
        .collect();

    let mut prefix_token_count = 0;

    // Try matching up to 3 tokens before the last name as a prefix
    for num_tokens in (1..=3).rev() {
        if last >= first + num_tokens {
            let potential_prefix = tokens[(last - num_tokens)..last]
                .iter()
                .map(|s| s.to_lowercase())
                .collect::<Vec<_>>()
                .join(" ");

            if author_surname_prefixes_lower.contains(&potential_prefix) {
                prefix_token_count = num_tokens;
                break;
            }
        }
    }

    if prefix_token_count > 0 {
        // Combine the prefix tokens with the last name
        let prefix_start = last - prefix_token_count;
        let combined = tokens[prefix_start..=last].join(" ");
        tokens[prefix_start] = combined;
        // Remove the tokens that were combined
        for _ in 0..prefix_token_count {
            tokens.remove(prefix_start + 1);
        }
        last = prefix_start;
    }

    let mut atokens = vec![tokens[last].clone()];
    atokens.extend_from_slice(&tokens[first..last]);
    if atokens.len() > 1 {
        atokens[0].push(',');
    }

    if suffix.is_empty() {
        atokens.join(" ")
    } else {
        format!("{}, {}", atokens.join(" "), suffix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_name() {
        assert_eq!(sort_author_name_apa("John Doe"), "Doe, John");
    }

    #[test]
    fn test_single_name() {
        assert_eq!(sort_author_name_apa("Madonna"), "Madonna");
    }

    #[test]
    fn test_already_sorted() {
        assert_eq!(sort_author_name_apa("Smith, John"), "Smith, John");
    }

    #[test]
    fn test_empty_string() {
        assert_eq!(sort_author_name_apa(""), "");
    }

    #[test]
    fn test_three_word_name() {
        assert_eq!(sort_author_name_apa("John Paul Jones"), "Jones, John Paul");
    }

    #[test]
    fn test_prefix_title_removal() {
        assert_eq!(sort_author_name_apa("Dr. John Doe"), "Doe, John");
        assert_eq!(sort_author_name_apa("Mr. John Doe"), "Doe, John");
        assert_eq!(sort_author_name_apa("Prof. John Doe"), "Doe, John");
    }

    #[test]
    fn test_generational_suffix() {
        assert_eq!(sort_author_name_apa("John Doe Jr."), "Doe, John, Jr.");
        assert_eq!(sort_author_name_apa("John Doe Sr."), "Doe, John, Sr.");
        assert_eq!(sort_author_name_apa("John Doe III"), "Doe, John, III");
    }

    #[test]
    fn test_post_nominal_removal() {
        assert_eq!(sort_author_name_apa("John Doe PhD"), "Doe, John");
        assert_eq!(
            sort_author_name_apa("John Doe BA Bsc M.S. PhD Esq"),
            "Doe, John"
        );
    }

    #[test]
    fn test_bracket_removal() {
        assert_eq!(sort_author_name_apa("John Doe (Author)"), "Doe, John");
        assert_eq!(sort_author_name_apa("John Doe [Deceased]"), "Doe, John");
        assert_eq!(
            sort_author_name_apa("John Doe {Ed.: fictional character}"),
            "Doe, John"
        );
        assert_eq!(
            sort_author_name_apa("John Doe (Author) [Deceased] {Ed.: fictional character}"),
            "Doe, John"
        );
    }

    #[test]
    fn test_organization_names() {
        assert_eq!(sort_author_name_apa("Coca Cola Inc."), "Coca Cola Inc.");
        assert_eq!(
            sort_author_name_apa("Microsoft Corporation"),
            "Microsoft Corporation"
        );
        assert_eq!(
            sort_author_name_apa("National Institute of Health"),
            "National Institute of Health"
        );
    }

    #[test]
    fn test_family_name_prefix() {
        assert_eq!(
            sort_author_name_apa("Example von Cruz"),
            "von Cruz, Example"
        );
        assert_eq!(
            sort_author_name_apa("John van der Berg"),
            "van der Berg, John"
        );
        assert_eq!(
            sort_author_name_apa("Marie De la Cruz"),
            "De la Cruz, Marie"
        );
    }

    #[test]
    fn test_two_word_name_with_family_prefix() {
        // Two-word names where first word is a family prefix should not be reformatted
        assert_eq!(sort_author_name_apa("von Neumann"), "von Neumann");
        assert_eq!(sort_author_name_apa("van Gogh"), "van Gogh");
    }

    #[test]
    fn test_combined_prefix_and_suffix() {
        assert_eq!(sort_author_name_apa("Dr. John Doe Jr."), "Doe, John, Jr.");
        assert_eq!(
            sort_author_name_apa("Prof. Marie von Berg Sr."),
            "von Berg, Marie, Sr."
        );
    }

    #[test]
    fn test_multiple_prefixes() {
        assert_eq!(sort_author_name_apa("Mr. Dr. John Doe"), "Doe, John");
    }

    #[test]
    fn test_whitespace_handling() {
        assert_eq!(sort_author_name_apa("  John   Doe  "), "Doe, John");
    }

    // Title sorting tests
    #[test]
    fn test_title_sort_with_the() {
        assert_eq!(sort_book_title("The Great Gatsby"), "Great Gatsby, The");
    }

    #[test]
    fn test_title_sort_with_a() {
        assert_eq!(
            sort_book_title("A Tale of Two Cities"),
            "Tale of Two Cities, A"
        );
    }

    #[test]
    fn test_title_sort_with_an() {
        assert_eq!(
            sort_book_title("An American Tragedy"),
            "American Tragedy, An"
        );
    }

    #[test]
    fn test_title_sort_no_article() {
        assert_eq!(sort_book_title("War and Peace"), "War and Peace");
    }

    #[test]
    fn test_title_sort_article_in_middle() {
        assert_eq!(sort_book_title("War of the Worlds"), "War of the Worlds");
    }

    #[test]
    fn test_title_sort_empty() {
        assert_eq!(sort_book_title(""), "");
    }

    #[test]
    fn test_title_sort_only_article() {
        assert_eq!(sort_book_title("The"), "The");
    }

    #[test]
    fn test_title_sort_single_word() {
        assert_eq!(sort_book_title("Dune"), "Dune");
    }

    #[test]
    fn test_title_sort_with_unicode() {
        assert_eq!(sort_book_title("El Niño"), "El Niño");
    }

    #[test]
    fn test_title_sort_with_numbers() {
        assert_eq!(sort_book_title("The 39 Steps"), "39 Steps, The");
    }
}
