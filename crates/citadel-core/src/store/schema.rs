diesel::table! {
    users (id) {
        id -> Text,
        username -> Text,
        password_hash -> Nullable<Text>,
        app_password -> Nullable<Text>,
        created_at -> BigInt,
    }
}
diesel::table! {
    external_identities (issuer, subject) {
        issuer -> Text,
        subject -> Text,
        user_id -> Text,
        created_at -> BigInt,
    }
}
diesel::table! {
    sessions (token_hash) {
        token_hash -> Text,
        user_id -> Text,
        created_at -> BigInt,
        expires_at -> BigInt,
    }
}
diesel::table! {
    libraries (id) {
        id -> Text,
        path -> Text,
        display_name -> Text,
        created_at -> BigInt,
    }
}
diesel::table! {
    properties (key) {
        key -> Text,
        value -> Text,
    }
}
diesel::table! {
    library_grants (user_id, library_id) {
        user_id -> Text,
        library_id -> Text,
        created_at -> BigInt,
    }
}
diesel::table! {
    provider_credentials (user_id, provider) {
        user_id -> Text,
        provider -> Text,
        key_id -> Text,
        nonce -> Binary,
        ciphertext -> Binary,
        label -> Nullable<Text>,
        created_at -> BigInt,
        verified_at -> Nullable<BigInt>,
    }
}
diesel::joinable!(sessions -> users (user_id));
diesel::joinable!(provider_credentials -> users (user_id));
diesel::joinable!(library_grants -> users (user_id));
diesel::joinable!(library_grants -> libraries (library_id));
diesel::joinable!(external_identities -> users (user_id));
diesel::allow_tables_to_appear_in_same_query!(
    users,
    external_identities,
    sessions,
    libraries,
    library_grants,
    properties,
    provider_credentials
);
