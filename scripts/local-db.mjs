import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
export function database(path=':memory:'){
 const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL');
 const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pa_connections'").get();
 if(!exists)db.exec(readFileSync(new URL('../drizzle/0000_connectors.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../drizzle/0001_multiuser.sql',import.meta.url),'utf8'));
 db.exec(readFileSync(new URL('../drizzle/0002_feishu_store.sql',import.meta.url),'utf8'));
 const wrapper={
  raw:db,
  prepare(sql){
   let args=[];const statement={bind(...values){args=values;return statement;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}};return statement;
  },
  async batch(statements){db.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}},
 };return wrapper;
}
