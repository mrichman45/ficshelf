//! Looking up a word or name while reading: Wiktionary's definitions and
//! Wikipedia's summary. Only the selected words are sent, to Wikimedia, and
//! only when she taps Look up.

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Default)]
pub struct Meaning {
    pub part: String,
    pub definitions: Vec<String>,
}

#[derive(Serialize, Default)]
pub struct Found {
    pub word: String,
    pub meanings: Vec<Meaning>,
    pub wiki_title: Option<String>,
    pub wiki_extract: Option<String>,
    pub wiki_url: Option<String>,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!(
            "FicShelf/",
            env!("CARGO_PKG_VERSION"),
            " (reading app; https://github.com/mrichman45/ficshelf)"
        ))
        .timeout(std::time::Duration::from_secs(15))
        .build()?)
}

/// Wiktionary's definitions come as HTML snippets; keep the text.
pub fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

pub fn meanings_from(v: &Value, lang: &str) -> Vec<Meaning> {
    let list = v[lang].as_array().or_else(|| v["en"].as_array());
    let mut out = Vec::new();
    for m in list.into_iter().flatten() {
        let defs: Vec<String> = m["definitions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d["definition"].as_str())
            .map(strip_tags)
            .filter(|d| !d.is_empty())
            .take(4)
            .collect();
        if !defs.is_empty() {
            out.push(Meaning { part: m["partOfSpeech"].as_str().unwrap_or("").to_string(), definitions: defs });
        }
        if out.len() >= 4 {
            break;
        }
    }
    out
}

pub async fn look_up(text: &str, lang: &str) -> Result<Found> {
    let word: String = text.trim().trim_matches(|c: char| !c.is_alphanumeric()).chars().take(80).collect();
    let mut found = Found { word: word.clone(), ..Default::default() };
    if word.is_empty() {
        return Ok(found);
    }
    let http = client()?;
    let wikt = async {
        // A lone word, or a short phrase as Wiktionary titles it.
        for title in [word.replace(' ', "_"), word.to_lowercase().replace(' ', "_")] {
            let url = format!("https://en.wiktionary.org/api/rest_v1/page/definition/{}", enc(&title));
            if let Ok(r) = http.get(url).send().await {
                if r.status().is_success() {
                    if let Ok(v) = r.text().await.map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) {
                        let m = meanings_from(&v, lang);
                        if !m.is_empty() {
                            return m;
                        }
                    }
                }
            }
        }
        Vec::new()
    };
    let wiki = async {
        let url = format!("https://en.wikipedia.org/api/rest_v1/page/summary/{}", enc(&word.replace(' ', "_")));
        let r = http.get(url).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        let v: Value = serde_json::from_str(&r.text().await.ok()?).ok()?;
        if v["type"].as_str() == Some("disambiguation") {
            return None;
        }
        Some((
            v["title"].as_str()?.to_string(),
            v["extract"].as_str()?.to_string(),
            v["content_urls"]["desktop"]["page"].as_str().map(str::to_string),
        ))
    };
    let (meanings, summary) = tokio::join!(wikt, wiki);
    found.meanings = meanings;
    if let Some((t, e, u)) = summary {
        found.wiki_title = Some(t);
        found.wiki_extract = Some(e);
        found.wiki_url = u;
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_read() {
        let v: Value = serde_json::from_str(
            r#"{"en":[{"partOfSpeech":"Noun","definitions":[{"definition":"A <a href=\"x\">young</a> cat."},{"definition":""}]}]}"#,
        )
        .unwrap();
        let m = meanings_from(&v, "en");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].part, "Noun");
        assert_eq!(m[0].definitions, vec!["A young cat.".to_string()]);
    }
}
