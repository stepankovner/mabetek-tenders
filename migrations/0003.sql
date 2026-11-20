CREATE TABLE IF NOT EXISTS embedding_cache(model TEXT NOT NULL,digest TEXT NOT NULL,vector TEXT NOT NULL,PRIMARY KEY(model,digest));
CREATE TABLE IF NOT EXISTS semantic_results(url TEXT PRIMARY KEY,model TEXT NOT NULL,profile TEXT NOT NULL,source_updated INTEGER NOT NULL,score REAL NOT NULL,scenario TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS semantic_rank ON semantic_results(score DESC);
