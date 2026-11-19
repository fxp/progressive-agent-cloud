import {createServer,request} from 'node:http';
import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const config=JSON.parse(readFileSync('/driver/command.json','utf8'));
const server=createServer((req,res)=>{const proxy=request({socketPath:'/proxy/model.sock',path:req.url,method:req.method,headers:req.headers},upstream=>{res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);});proxy.on('error',()=>res.writeHead(502).end());req.pipe(proxy);});
await new Promise(resolve=>server.listen(4317,'127.0.0.1',resolve));
mkdirSync(process.env.CODEX_HOME,{recursive:true});mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});
if(config.agent==='codex')writeFileSync(process.env.CODEX_HOME+'/config.toml',[
 'model_provider = "progressive"','model = '+JSON.stringify(config.model),
 'approval_policy = "never"','sandbox_mode = "danger-full-access"','web_search = "disabled"','[model_providers.progressive]',
 'name = "Progressive model proxy"','base_url = "http://127.0.0.1:4317/v1"','env_key = "PA_PROXY_KEY"','wire_api = "responses"',
].join('\n'));
const binary='/opt/pa-tools/node_modules/.bin/'+(config.agent==='codex'?'codex':'claude');
const args=config.agent==='codex'?['exec',...(config.resume?['resume',config.resume]:[]),'--json','--skip-git-repo-check',...(!config.resume?['--sandbox','danger-full-access']:[]),'-']:['--bare','-p','--output-format','json','--permission-mode','acceptEdits','--permission-prompts','none','--tools','Read,Edit,Write,Glob,Grep,Bash','--allowedTools','Read,Edit,Write,Glob,Grep,Bash','--disable-slash-commands','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}','--model',config.model,...(config.resume?['--resume',config.resume]:['--session-id',config.sessionId])];
const child=spawn(binary,args,{cwd:'/workspace',env:{PATH:process.env.PATH,HOME:'/home/agent',TMPDIR:'/tmp',CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,PA_PROXY_KEY:process.env.PA_PROXY_KEY,OPENAI_API_KEY:process.env.PA_PROXY_KEY,ANTHROPIC_API_KEY:process.env.PA_PROXY_KEY,ANTHROPIC_BASE_URL:'http://127.0.0.1:4317',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CI:'true'},stdio:['pipe','pipe','pipe']});
// Fresh child pipes keep native CLI stdout blocking; Node handles backpressure
// instead of handing a nonblocking Docker stdout descriptor to Rust binaries.
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.stdin.on('error',error=>{if(error.code!=='EPIPE')console.error('CLI input failed');});child.stdin.end(config.prompt);const code=await new Promise(resolve=>{child.once('error',()=>resolve(1));child.once('exit',code=>resolve(code??1));});server.closeAllConnections();server.close();process.exitCode=code;
