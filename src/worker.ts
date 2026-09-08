export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
});
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
async function audit(env: Env, entityType: string, entityId: string, action: string, before: unknown, after: unknown) {
  await env.DB.prepare(`INSERT INTO audit_log (id, occurred_at, entity_type, entity_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id(), now(), entityType, entityId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after)).run();
}
async function body(request: Request) { return await request.json<Record<string, unknown>>(); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const result = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        return json({ ok: result?.ok === 1 });
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const [accounts, categories, methods, suggestions] = await Promise.all([
          env.DB.prepare(`SELECT * FROM accounts WHERE deleted_at IS NULL AND is_active=1 ORDER BY name`).all(),
          env.DB.prepare(`SELECT * FROM categories WHERE deleted_at IS NULL AND is_active=1 ORDER BY parent_id IS NOT NULL, sort_order, name`).all(),
          env.DB.prepare(`SELECT * FROM payment_methods WHERE deleted_at IS NULL AND is_active=1 ORDER BY account_id, name`).all(),
          env.DB.prepare(`SELECT description FROM description_suggestions ORDER BY usage_count DESC, last_used_at DESC LIMIT 50`).all(),
        ]);
        return json({ accounts: accounts.results, categories: categories.results, paymentMethods: methods.results, suggestions: suggestions.results.map((x: any) => x.description) });
      }
      if (request.method === 'GET' && url.pathname === '/api/transactions') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 100), 1), 500), offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
        const q = (url.searchParams.get('q') || '').trim(), type = url.searchParams.get('type'), account = url.searchParams.get('account'), category = url.searchParams.get('category'), method = url.searchParams.get('method');
        const clauses = ['t.deleted_at IS NULL']; const params: unknown[] = [];
        if (q) { clauses.push(`(LOWER(t.description) LIKE LOWER(?) OR LOWER(t.note) LIKE LOWER(?) OR LOWER(COALESCE(c.name,'')) LIKE LOWER(?) OR LOWER(COALESCE(p.name,'')) LIKE LOWER(?) OR LOWER(a.name) LIKE LOWER(?) OR LOWER(COALESCE(pm.name,'')) LIKE LOWER(?))`); const s=`%${q}%`; params.push(s,s,s,s,s,s); }
        if (type === 'income' || type === 'expense') { clauses.push('t.transaction_type = ?'); params.push(type); }
        if (account) { clauses.push('t.account_id = ?'); params.push(account); }
        if (category) { clauses.push('t.category_id = ?'); params.push(category); }
        if (method) { clauses.push('t.payment_method_id = ?'); params.push(method); }
        const result = await env.DB.prepare(`SELECT t.*, a.name AS account_name, c.name AS category_name, p.name AS payee_name, pm.name AS payment_method_name FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN payees p ON p.id=t.payee_id LEFT JOIN payment_methods pm ON pm.id=t.payment_method_id WHERE ${clauses.join(' AND ')} ORDER BY t.occurred_at DESC LIMIT ? OFFSET ?`).bind(...params,limit,offset).all();
        return json(result.results);
      }
      if (request.method === 'GET' && url.pathname === '/api/dashboard') {
        const rows = await env.DB.prepare(`SELECT t.*, c.name AS category_name FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.deleted_at IS NULL`).all<any>();
        const accounts = await env.DB.prepare(`SELECT * FROM accounts WHERE deleted_at IS NULL AND is_active=1 ORDER BY name`).all<any>();
        const transactions = rows.results, today=new Date(), startOfWeek=new Date(today), startOfMonth=new Date(today.getFullYear(),today.getMonth(),1);
        startOfWeek.setHours(0,0,0,0); startOfWeek.setDate(today.getDate()-((today.getDay()+6)%7));
        const sums=(start:Date)=>transactions.reduce((r:any,t:any)=>{if(new Date(t.occurred_at)>=start)r[t.transaction_type]+=t.amount_minor;return r;},{income:0,expense:0});
        const month=sums(startOfMonth),week=sums(startOfWeek),categories:Record<string,number>={};
        transactions.filter((t:any)=>t.transaction_type==='expense'&&new Date(t.occurred_at)>=startOfMonth).forEach((t:any)=>categories[t.category_name||'Uncategorized']=(categories[t.category_name||'Uncategorized']||0)+t.amount_minor);
        const balances=accounts.results.map((a:any)=>({...a,balance_minor:a.opening_balance_minor+transactions.filter((t:any)=>t.account_id===a.id).reduce((s:number,t:any)=>s+(t.transaction_type==='income'?t.amount_minor:-t.amount_minor),0)}));
        return json({week,month,categories,balances});
      }
      if (request.method === 'POST' && url.pathname === '/api/accounts') {
        const b=await body(request),name=String(b.name||'').trim(); if(!name)return json({error:'Account name is required'},{status:400});
        const created=now(),account={id:id(),name,opening_balance_minor:Math.round(Number(b.openingBalance||0)*100),opening_balance_at:String(b.openingBalanceAt||created),is_active:1,created_at:created,updated_at:created,deleted_at:null};
        await env.DB.prepare(`INSERT INTO accounts (id,name,opening_balance_minor,opening_balance_at,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`).bind(account.id,account.name,account.opening_balance_minor,account.opening_balance_at,1,created,created).run();
        await audit(env,'account',account.id,'create',null,account); return json(account,{status:201});
      }
      if (request.method === 'POST' && url.pathname === '/api/categories') {
        const b=await body(request),name=String(b.name||'').trim(); if(!name)return json({error:'Category name is required'},{status:400});
        const created=now(),category={id:id(),name,parent_id:b.parentId?String(b.parentId):null,kind:'both',sort_order:0,is_active:1,created_at:created,updated_at:created,deleted_at:null};
        await env.DB.prepare(`INSERT INTO categories (id,name,parent_id,kind,sort_order,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(category.id,category.name,category.parent_id,'both',0,1,created,created).run();
        await audit(env,'category',category.id,'create',null,category); return json(category,{status:201});
      }
      if (request.method === 'POST' && url.pathname === '/api/payment-methods') {
        const b=await body(request),name=String(b.name||'').trim(),accountId=String(b.accountId||''); if(!name||!accountId)return json({error:'Payment method name and account are required'},{status:400});
        const created=now(),method={id:id(),account_id:accountId,name,is_active:1,created_at:created,updated_at:created,deleted_at:null};
        await env.DB.prepare(`INSERT INTO payment_methods (id,account_id,name,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?)`).bind(method.id,method.account_id,method.name,1,created,created).run();
        await audit(env,'payment_method',method.id,'create',null,method); return json(method,{status:201});
      }
      if (request.method === 'POST' && url.pathname === '/api/transactions') {
        const b=await body(request),accountId=String(b.accountId||''),amount=Math.round(Number(b.amount||0)*100),type=String(b.type||'expense');
        if(!accountId||amount<=0||!['expense','income'].includes(type))return json({error:'Account, valid amount and type are required'},{status:400});
        const created=now(),occurredAt=String(b.occurredAt||created),description=String(b.description||'').trim(),note=String(b.note||''),categoryId=b.categoryId?String(b.categoryId):null,paymentMethodId=b.methodId?String(b.methodId):null,status=b.status==='uncleared'?'uncleared':'cleared';
        const tx={id:id(),account_id:accountId,payment_method_id:paymentMethodId,category_id:categoryId,payee_id:null,transaction_type:type,amount_minor:amount,occurred_at:occurredAt,description,note,status,parent_transaction_id:null,recurring_rule_id:null,transfer_id:null,is_split_parent:0,created_at:created,updated_at:created,deleted_at:null};
        await env.DB.prepare(`INSERT INTO transactions (id,account_id,payment_method_id,category_id,payee_id,transaction_type,amount_minor,occurred_at,description,note,status,parent_transaction_id,recurring_rule_id,transfer_id,is_split_parent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(tx.id,tx.account_id,tx.payment_method_id,tx.category_id,tx.payee_id,tx.transaction_type,tx.amount_minor,tx.occurred_at,tx.description,tx.note,tx.status,null,null,null,0,created,created).run();
        if(description)await env.DB.prepare(`INSERT INTO description_suggestions (id,description,usage_count,last_used_at,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(description) DO UPDATE SET usage_count=usage_count+1,last_used_at=excluded.last_used_at,updated_at=excluded.updated_at`).bind(id(),description,1,created,created,created).run();
        await audit(env,'transaction',tx.id,'create',null,tx); return json(tx,{status:201});
      }
      return json({error:'Not found'},{status:404});
    } catch(error) { console.error(error); return json({error:error instanceof Error?error.message:'Server error'},{status:500}); }
  },
};
