use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Text is normalized by JavaScript so locale casing stays identical to the UI.
#[napi(object)]
pub struct SearchDocument {
    pub id: String,
    pub title: String,
    pub supporting: String,
}

#[napi]
#[derive(Default)]
pub struct SearchIndex {
    state: Mutex<IndexState>,
}

#[derive(Default)]
struct IndexState {
    documents: HashMap<String, Arc<SearchDocument>>,
    ordered: Arc<Vec<Arc<SearchDocument>>>,
}

#[napi]
impl SearchIndex {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[napi]
    pub fn clear(&self) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::from_reason("Search index lock poisoned"))?;
        *state = IndexState::default();
        Ok(())
    }

    /// Reuse unchanged text and publish one immutable snapshot for queued queries.
    #[napi]
    pub fn synchronize(&self, updates: Vec<SearchDocument>, ids: Vec<String>) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::from_reason("Search index lock poisoned"))?;
        let mut next = state.documents.clone();
        for document in updates {
            next.insert(document.id.clone(), Arc::new(document));
        }
        let mut documents = HashMap::with_capacity(ids.len());
        let mut ordered = Vec::with_capacity(ids.len());
        for id in ids {
            let document = next.remove(&id).ok_or_else(|| {
                Error::new(Status::InvalidArg, "Missing or duplicate search document")
            })?;
            ordered.push(Arc::clone(&document));
            documents.insert(id, document);
        }
        state.documents = documents;
        state.ordered = Arc::new(ordered);
        Ok(())
    }

    #[napi]
    pub fn query(&self, query: String, terms: Vec<String>) -> Result<AsyncTask<SearchTask>> {
        let state = self
            .state
            .lock()
            .map_err(|_| Error::from_reason("Search index lock poisoned"))?;
        Ok(AsyncTask::new(SearchTask {
            documents: Arc::clone(&state.ordered),
            query,
            terms,
        }))
    }
}

pub struct SearchTask {
    documents: Arc<Vec<Arc<SearchDocument>>>,
    query: String,
    terms: Vec<String>,
}

fn search(documents: &[Arc<SearchDocument>], query: &str, terms: &[String]) -> Vec<String> {
    // Six ordered buckets preserve the original ranking without allocating/sorting
    // one JavaScript result object per matching document.
    let mut buckets: [Vec<String>; 6] = Default::default();
    for document in documents {
        let title = &document.title;
        let supporting = &document.supporting;
        // Terms contain no whitespace, so they cannot span the title/body separator.
        if !terms
            .iter()
            .all(|term| title.contains(term.as_str()) || supporting.contains(term.as_str()))
        {
            continue;
        }
        let score = if title == query {
            0
        } else if title.starts_with(query) {
            1
        } else if title.contains(query) {
            2
        } else if terms.iter().all(|term| title.contains(term.as_str())) {
            3
        } else if supporting.contains(query) {
            4
        } else {
            5
        };
        buckets[score].push(document.id.clone());
    }
    buckets.into_iter().flatten().collect()
}

impl Task for SearchTask {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(search(&self.documents, &self.query, &self.terms))
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
