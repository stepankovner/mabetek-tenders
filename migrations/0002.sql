CREATE TABLE notices(url TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT,published TEXT,updated INTEGER DEFAULT(unixepoch()));
CREATE TABLE agent_state(id INTEGER PRIMARY KEY CHECK(id=1),seen INTEGER,free_bytes INTEGER,paused INTEGER NOT NULL DEFAULT 0);
INSERT INTO agent_state(id) VALUES(1);
CREATE TABLE pairing(digest TEXT PRIMARY KEY,expires INTEGER NOT NULL);
CREATE TABLE owner(id TEXT PRIMARY KEY,singleton INTEGER UNIQUE DEFAULT 1 CHECK(singleton=1));
INSERT INTO sources(id,url) VALUES('eis','https://zakupki.gov.ru/epz/order/extendedsearch/rss.html');
ALTER TABLE jobs ADD COLUMN input TEXT;
CREATE TABLE decisions(owner TEXT,lot INTEGER,revision INTEGER,reason TEXT NOT NULL,PRIMARY KEY(owner,lot,revision));
