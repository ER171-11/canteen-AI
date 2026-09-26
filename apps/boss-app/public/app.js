/* ====== 熊猫 logo 随机 ====== */
(function(){
  var p = Math.random() < 0.5 ? 'panda_female.png' : 'panda_male.png';
  document.querySelectorAll('.panda-logo').forEach(function(i){ i.src = p; });
})();

/* ====== Toast ====== */
function toast(msg){
  var sc=document.querySelector('.screen'); if(!sc) return;
  var t=document.createElement('div'); t.className='toast'; t.textContent=msg;
  sc.appendChild(t);
  setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); },1200);
}

/* ====== 骨架屏 ====== */
var skelNode=document.createElement('div');
skelNode.className='skel-overlay';
skelNode.innerHTML='<div class="skel-bar lg"></div><div class="skel-bar t"></div><div class="skel-bar card"></div><div class="skel-bar card"></div><div class="skel-bar full2"></div><div class="skel-bar card"></div>';
function triggerSkel(section){
  if(!section) return;
  section.appendChild(skelNode);
  skelNode.classList.add('on');
  void skelNode.offsetWidth;
  setTimeout(function(){
    skelNode.classList.remove('on');
    if(skelNode.parentNode) skelNode.parentNode.removeChild(skelNode);
  },600);
}

/* ====== 最近访问记录 ====== */
var recent = JSON.parse(localStorage.getItem('pf_recent')||'[]');
function pushRecent(m){
  recent = recent.filter(function(x){return x!==m;});
  recent.unshift(m);
  recent = recent.slice(0,4);
  localStorage.setItem('pf_recent', JSON.stringify(recent));
  renderRecent();
}
var MOD_NAMES = {analysis:'经营分析',staff:'排班员工',vip:'会员营销',pos:'堂食收银',takeout:'外卖平台',booking:'预订排队',foodsafe:'食安证照',equipment:'设备能耗',finance:'财务税务',supply:'供应链',review:'顾客口碑',loss:'损耗报损'};

/* ====== 导航 ====== */
function show(id, tabKey){
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('on'); });
  document.querySelectorAll('.tab[data-p="'+tabKey+'"]').forEach(function(t){ t.classList.add('on'); });
  document.querySelectorAll('.screen-body').forEach(function(s){ s.classList.add('hide'); });
  var el = document.getElementById(id);
  if(el){ el.classList.remove('hide'); }
  var app = document.getElementById('app');
  if(app){ app.scrollTop = 0; }
  if(id!=='p-chat') triggerSkel(el);
}
function go(p){ show('p-'+p, p); }
function goModule(m){ show('p-m-'+m, 'more'); pushRecent(m); renderHomeHeatTip && renderHomeHeatTip(); }
function backMore(){ show('p-more','more'); }

/* Tab 点击 */
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){ go(t.dataset.p); });
});

/* ====== pill 子页绑定 ====== */
function bindPills(id){
  var grp = document.getElementById(id);
  if(!grp) return;
  grp.querySelectorAll('.pill').forEach(function(p){
    p.addEventListener('click', function(){
      grp.querySelectorAll('.pill').forEach(function(x){ x.classList.remove('on'); });
      p.classList.add('on');
      var par = p.closest('section');
      if(!par) return;
      par.querySelectorAll('.sub-page').forEach(function(s){ s.classList.remove('on'); });
      var sp = par.querySelector('#'+p.dataset.sp);
      if(sp){ sp.classList.add('on'); }
    });
  });
}
['inv-pills','kt-pills','an-pills','st-pills','vip-pills','pos-pills','to-pills','bk-pills','fs-pills','eq-pills','fin-pills','sup-pills','rv-pills','ls-pills'].forEach(bindPills);

/* ====== 菜单分类筛选 menu-cat ====== */
document.querySelectorAll('#menucat .mc').forEach(function(mc){
  mc.addEventListener('click', function(){
    document.querySelectorAll('#menucat .mc').forEach(function(x){ x.classList.remove('on'); });
    mc.classList.add('on');
    var f = mc.dataset.f;
    document.querySelectorAll('.rec-row').forEach(function(r){
      if(f==='all' || r.dataset.cat===f){ r.style.display=''; } else { r.style.display='none'; }
    });
  });
});

/* ====== 热力图渲染 renderHeat + 单元格点选 ====== */
function renderHeat(el, rows, cols){
  if(!el) return;
  el.innerHTML = '';
  var lbs = ['一','二','三','四','五','六','日'];
  var palette = ['#EEF1F5','#FBD3CC','#F48FB1','#C2185B'];
  for(var r=0;r<rows;r++){
    var lb = document.createElement('div');
    lb.className='heat-lb';
    lb.textContent = rows<=2 ? (r===0?'午':'晚') : lbs[r];
    el.appendChild(lb);
    for(var c=0;c<cols;c++){
      var cell = document.createElement('div');
      cell.className='heat-cell';
      var intensity = 0;
      if(rows<=2){
        intensity = (c>=9&&c<=13)?(r===0?3:2):(c>=17&&c<=20)?(r===0?2:4):1;
      } else {
        if(c>=11&&c<=13){ intensity = 3; }
        else if(c>=18&&c<=20){ intensity = r===5?4:3; }
        else if(c>=14&&c<=17){ intensity=1; }
        else if(c>=9&&c<=10){ intensity=1; }
        else { intensity=0; }
      }
      cell.style.background = palette[intensity] || '#EEF1F5';
      cell.dataset.r=r; cell.dataset.c=c; cell.dataset.lv=intensity;
      el.appendChild(cell);
    }
  }
}
renderHeat(document.getElementById('heatGrid'), 7, 24);
renderHeat(document.getElementById('homeHeat'), 2, 12);

/* 热力图单元格点选（钻取只读） */
function bindHeatCells(){
  var tip = document.getElementById('heatTip');
  document.querySelectorAll('#heatGrid .heat-cell').forEach(function(cell){
    cell.addEventListener('click', function(){
      document.querySelectorAll('#heatGrid .heat-cell.cur').forEach(function(x){x.classList.remove('cur');});
      cell.classList.add('cur');
      var r=+cell.dataset.r, c=+cell.dataset.c, lv=+cell.dataset.lv;
      var day=['一','二','三','四','五','六','日'][r];
      var lvTxt=['空闲','轻度','中热','高峰','峰值'][lv];
      var orders = lv*8 + Math.floor(c%5);
      var rev = orders * 27.7;
      if(tip) tip.innerHTML='周'+day+' '+c+':00 → <b>'+lvTxt+'</b> · 约 '+orders+' 单 · 营收 ¥'+rev.toFixed(0)+'（只读钻取）';
    });
  });
}
bindHeatCells();
function renderHomeHeatTip(){ /* 占位，供 goModule 安全调用 */ }

/* ====== 用量换算：按文档本批原料（面主料500g+色汁/水220g+盐3g）等比放大 ======
   文档写明剂子10-11g、生饺25-27g；出成个数/馅重为推算，不写入「文档参数」。 */
var RECIPE_BATCH = 67; // 推算：723÷10.5×0.97，仅作换算分母
function calcQty(el){
  var n = parseInt(el.value, 10) || RECIPE_BATCH;
  var qn = document.getElementById('qtyN');
  if(qn){ qn.textContent = n; }
  var box = document.getElementById('calcBox');
  if(!box) return;
  var k = n / RECIPE_BATCH;
  var flour = 0.5 * k, juice = 0.22 * k, pork = 0.5 * k;
  var dong = 0.1 * k, bi = 0.1 * k;
  var saltFace = 3 * k, oil = 13 * k, saltFill = 5 * k;
  box.innerHTML =
    '<div class="lab"><span>按本批原料等比（文档用量）</span><span>'+n+' 个</span></div>'+
    '<div class="calc-line"><span>五得利雪花粉八星</span><span>'+flour.toFixed(2)+' kg</span></div>'+
    '<div class="calc-line"><span>火龙果汁</span><span class="g">'+juice.toFixed(2)+' kg</span></div>'+
    '<div class="calc-line"><span>猪前肩肉（三肥七瘦）</span><span>'+pork.toFixed(2)+' kg</span></div>'+
    '<div class="calc-line"><span>冬菇 / 荸荠</span><span>'+dong.toFixed(2)+' / '+bi.toFixed(2)+' kg</span></div>'+
    '<div class="calc-line"><span>面盐 / 馅盐 / 香油</span><span>'+saltFace.toFixed(0)+'g / '+saltFill.toFixed(0)+'g / '+oil.toFixed(0)+'g</span></div>';
}

/** 配方抽屉：原料/步骤严格用文档字段；推算单独成块且标明「推算」 */
function buildRecipeHtml(item){
  item = item || window.__wufuRecipe || {};
  var bff = null;
  if(window.__bffRecipes && item.color){
    bff = (window.__bffRecipes || []).find(function(r){
      return r.color === item.color && (!item.filling || (r.filling || '').indexOf(String(item.filling).replace(/馅$/,'')) >= 0 || String(item.filling).indexOf(r.filling) >= 0);
    }) || (window.__bffRecipes || []).find(function(r){ return r.color === item.color; });
  }
  var faceDetail = item.face_detail
    || (bff && Array.isArray(bff.face) && bff.face.length ? bff.face.join('、') : null)
    || (bff && bff.face_main
      ? ('五得利雪花粉八星500g、' + String(bff.face_main) + '、食盐3g')
      : '五得利雪花粉八星500g、火龙果汁220g、食盐3g');
  var main = (bff && Array.isArray(bff.main) && bff.main.length)
    ? bff.main.join('、') : '猪前肩肉（三肥七瘦）500g';
  var aux = (bff && Array.isArray(bff.aux) && bff.aux.length)
    ? bff.aux.join('、') : '冬菇100g、荸荠100g';
  var season = (bff && Array.isArray(bff.seasoning) && bff.seasoning.length)
    ? bff.seasoning.join('、')
    : '食盐5g、白绵糖1g、王守义十三香1g、葱花30g、姜末20g、料水200g（花椒10g、大料5g、小茴香5g、香叶3g）、海天蚝油20g、海天生抽18g、海天老抽10g、白胡椒粉1.5g、味精4g、家乐鸡精6g、料油40g、香油13g（古币牌）';
  var colorName = item.color ? (item.color + '色') : '红色';
  var bless = item.blessing || '';
  var filling = item.filling || (bff && bff.filling) || '猪肉冬菇荸荠馅';
  var steps = (bff && Array.isArray(bff.steps) && bff.steps.length) ? bff.steps : null;
  var stepHtml;
  if(steps){
    stepHtml = steps.map(function(s, i){
      var cls = i < 2 ? ' done' : (i === 2 ? ' now' : '');
      var text = String(s).replace(/^\d+[、\.．]\s*/, '');
      return '<div class="tl-step'+cls+'"><div class="tl-time">'+(i+1)+'</div><div class="tl-ti">'+escHtml(text)+'</div></div>';
    }).join('');
  } else {
    stepHtml =
      '<div class="tl-step done"><div class="tl-time">2</div><div class="tl-ti">雪花粉500g与食盐3g混合</div></div>'+
      '<div class="tl-step done"><div class="tl-time">3</div><div class="tl-ti">分次倒入火龙果汁220g，搅拌至絮状</div></div>'+
      '<div class="tl-step now"><div class="tl-time">5</div><div class="tl-ti">覆盖保鲜膜，醒发30分钟</div></div>'+
      '<div class="tl-step"><div class="tl-time">15</div><div class="tl-ti">下剂，每个剂子10-11g</div></div>'+
      '<div class="tl-step"><div class="tl-time">17</div><div class="tl-ti">生饺的标准为25-27g</div></div>'+
      '<div class="tl-step"><div class="tl-time">19</div><div class="tl-ti">沸腾后点凉水，重复3次至浮起</div></div>';
  }
  return ''+
    '<div class="card">'+
      '<div class="card-h"><div class="ttl"><i class="em"></i>原料配比</div></div>'+
      '<div class="stat-line"><span>面主料</span><span style="text-align:right;max-width:62%;line-height:1.35">'+escHtml(faceDetail)+'</span></div>'+
      '<div class="stat-line"><span>主料</span><span style="text-align:right;max-width:62%;line-height:1.35">'+escHtml(main)+'</span></div>'+
      '<div class="stat-line"><span>辅料（'+escHtml(filling)+'）</span><span style="text-align:right;max-width:62%;line-height:1.35">'+escHtml(aux)+'</span></div>'+
      '<div class="stat-line"><span>调料</span><span style="text-align:right;max-width:62%;line-height:1.35">'+escHtml(season)+'</span></div>'+
    '</div>'+
    '<div class="card">'+
      '<div class="card-h"><div class="ttl"><i class="em"></i>工艺参数（文档）</div></div>'+
      '<div class="stat-line"><span>剂子</span><span>每个 10-11g</span></div>'+
      '<div class="stat-line"><span>生饺标准</span><span>25-27g</span></div>'+
      '<div class="stat-line"><span>醒发</span><span>30 分钟</span></div>'+
      '<div class="stat-line"><span>点水</span><span>沸腾后点凉水，重复 3 次</span></div>'+
      (bless ? '<div class="stat-line"><span>五福寓意</span><span>'+escHtml(colorName)+' · '+escHtml(bless)+'</span></div>' : '')+
    '</div>'+
    '<div class="card">'+
      '<div class="card-h"><div class="ttl"><i class="em"></i>推算（非文档原文）</div></div>'+
      '<div class="stat-line"><span>面团合计</span><span>723g（500+220+3）</span></div>'+
      '<div class="stat-line"><span>理论出成</span><span>66–72 个（÷10–11g）</span></div>'+
      '<div class="stat-line"><span>建议批次</span><span>67 个（中位扣约 3% 下剂损耗）</span></div>'+
      '<div class="stat-line"><span>馅重推算</span><span class="g">14–16g（生饺 − 剂子）</span></div>'+
      '<div class="note" style="margin-top:8px">文档只写「取适量馅料」与生饺 25-27g；馅重由生饺标准减剂子推得，验算：10.5+15.5=26g。</div>'+
    '</div>'+
    '<div class="card">'+
      '<div class="card-h"><div class="ttl"><i class="em"></i>制作方法</div></div>'+
      '<div class="timeline">'+stepHtml+'</div>'+
    '</div>'+
    '<div class="card">'+
      '<div class="card-h"><div class="ttl"><i class="em"></i>用量换算</div></div>'+
      '<div class="slider-row"><input type="range" min="34" max="670" value="67" step="67" oninput="calcQty(this)"><div class="qty"><span id="qtyN">67</span><small> 个</small></div></div>'+
      '<div class="calc-box" id="calcBox">'+
        '<div class="lab"><span>按本批原料等比（文档用量）</span><span>67 个</span></div>'+
        '<div class="calc-line"><span>五得利雪花粉八星</span><span>0.50 kg</span></div>'+
        '<div class="calc-line"><span>火龙果汁</span><span class="g">0.22 kg</span></div>'+
        '<div class="calc-line"><span>猪前肩肉（三肥七瘦）</span><span>0.50 kg</span></div>'+
        '<div class="calc-line"><span>冬菇 / 荸荠</span><span>0.10 / 0.10 kg</span></div>'+
        '<div class="calc-line"><span>面盐 / 馅盐 / 香油</span><span>3g / 5g / 13g</span></div>'+
      '</div>'+
      '<div class="note" style="margin-top:8px">⚠ 红色色源为火龙果汁，不可替换。</div>'+
    '</div>';
}
function escHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ====== AI 销量预测：置信区间滑块重绘 ======
   滑块 80~95% 控制置信度；系数：乐观=1+(1-conf)*1.8，保守=1-(1-conf)*1.8。
   90% 时还原默认（乐观×1.18/保守×0.82）。重绘乐观/保守 path、置信带 fill、峰值标注、备货清单上下界。 */
function updateFcstConf(v){
  var conf = parseInt(v,10)/100;
  var optF = 1 + (1-conf)*1.8;
  var consF = 1 - (1-conf)*1.8;
  var confEl = document.getElementById('fcstConfVal'); if(confEl) confEl.textContent = v;
  // 预测主线 y（固定）与原始 y 偏移（90% 时）at x=270/300/320
  var pred = [42, 34, 28];
  var base = [5, 6, 8];
  var scale = (1-conf)*10; // 0.90→1.0, 0.80→2.0, 0.95→0.5
  var opt = pred.map(function(p,i){ return p - base[i]*scale; });
  var cons = pred.map(function(p,i){ return p + base[i]*scale; });
  var band = document.getElementById('fcstBandFill');
  if(band) band.setAttribute('d', 'M270,'+opt[0]+' L300,'+opt[1]+' L320,'+opt[2]+' L320,'+cons[2]+' L300,'+cons[1]+' L270,'+cons[0]+' Z');
  var optLine = document.getElementById('fcstOptLine');
  if(optLine) optLine.setAttribute('d', 'M270,'+opt[0]+' L300,'+opt[1]+' L320,'+opt[2]);
  var consLine = document.getElementById('fcstConsLine');
  if(consLine) consLine.setAttribute('d', 'M270,'+cons[0]+' L300,'+cons[1]+' L320,'+cons[2]);
  var peakTxt = document.getElementById('fcstPeakTxt');
  if(peakTxt) peakTxt.textContent = '峰值日 · 上界¥'+Math.round(100*optF)+' / 预测¥100 / 下界¥'+Math.round(100*consF);
  // 备货清单联动：预测值固定，上下界按系数重算
  document.querySelectorAll('#an-fcst .fcst-ds').forEach(function(s){
    var p = parseFloat(s.dataset.pred);
    var prec = parseInt(s.dataset.prec,10)||1;
    var u = s.dataset.unit||'';
    var o = (p*optF).toFixed(prec);
    var c = (p*consF).toFixed(prec);
    s.textContent = '保守 '+c+' / 预测 '+s.dataset.pred+' / 乐观 '+o+' '+u;
  });
}

/* ====== Kimi 视觉识别 ====== */
var kimiData = {
  recv: {
    title:'验货识别',
    rows:[['猪肉前肩','张记肉业','pass'],['雪花粉八星','五得利','pass'],['火龙果汁','菜篮子','pass']],
    note:'批次 B0924 / M0922 / H0923 均已溯源，检验报告合格。',
    cta:'登记入库', conf:'98%'
  },
  stock: {
    title:'库存盘点',
    rows:[['猪肉前肩','8.2 kg','pass'],['墨鱼汁','620 g','warn'],['火龙果汁','440 g','fail']],
    note:'火龙果汁仅够 2 天，建议补货 ¥620。',
    cta:'生成补货单', conf:'96%'
  },
  qc: {
    title:'成品质检',
    rows:[['褶纹规整','94%','pass'],['色泽饱满','96%','pass'],['形态鼓胀','92%','pass'],['重量估值','25.8g','pass']],
    note:'成品合格率 94%，持续改善中。',
    cta:'复核通过', conf:'95%'
  },
  plate: {
    title:'摆盘质检',
    rows:[['分量达标','pass','pass'],['配色五福','pass','pass'],['点缀规范','pass','pass'],['摆盘 SOP','pass','pass']],
    note:'摆盘符合宫廷御膳 SOP，五色齐整。',
    cta:'复核通过', conf:'93%'
  },
  sample: {
    title:'留样登记',
    rows:[['菜品识别','红色长寿饺','pass'],['48h 到期','后日 11:30','warn'],['克重','125g','pass'],['标签','已贴','pass']],
    note:'留样符合 48h 规范，建议标签注明到期时间。',
    cta:'登记留样', conf:'91%'
  },
  uniform: {
    title:'着装 SOP 合规',
    rows:[['工服整洁','pass','pass'],['帽子佩戴','pass','pass'],['口罩规范','pass','pass'],['洗手消毒','pass','pass'],['SOP 合规','pass','pass']],
    note:'着装合规，符合食品安全操作规范。',
    cta:'记录合规', conf:'90%'
  }
};
var kimiCardIds = { recv:'kimiRecv', stock:'kimiStock', qc:'kimiQc', plate:'kimiPlate', sample:'kimiSample', uniform:'kimiUniform' };
var tagMap = { pass:'kpass', fail:'kfail', warn:'kwarn' };

/* ====== Kimi 视觉：可接通真实 BFF ======
   配置 window.KIMI_BFF_URL 后走真实调用（拍照→base64→POST→渲染）；
   留空则用内置 mock 演示；真实调用失败自动降级 mock，不阻断业务。
   示例：window.KIMI_BFF_URL = 'https://your-bff/api/kimi/vision';
   契约详见《Kimi视觉API调用契约.md》。红线：Kimi 只识别+建议，写操作需点确认。 */
window.KIMI_BFF_URL = window.KIMI_BFF_URL || '/api/kimi/vision';

function renderKimiCard(card, d, type){
  var rowsHtml = (d.rows||[]).map(function(r){
    var st = r[2], dotCls = tagMap[st] || 'kpass';
    return '<div class="kimi-row"><div class="kk"><i class="'+dotCls+'"></i>'+r[0]+'</div><span>'+r[1]+'</span></div>';
  }).join('');
  card.innerHTML =
    '<div class="kh"><div class="km"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5"/></svg>'+d.title+'</div><span class="kimi-conf">置信 '+d.conf+'</span></div>'+
    '<div class="kb">'+rowsHtml+
      '<div class="kimi-thumbs"><div class="kt">原图</div><div class="kt">识别框</div><div class="kt">对比</div></div>'+
      '<div class="kimi-note">'+d.note+'</div>'+
      '<button class="pbtn" style="margin-top:8px" onclick="kimiCta(\''+(type||'')+'\',\''+d.cta+'\')">'+d.cta+'</button>'+
    '</div>';
  card.style.display = 'block';
}
/* Kimi 分阶段等待态：上传中→识别中→生成建议中…
   stream=true 时不启本地定时器，阶段文案/进度由 BFF SSE stage 事件驱动（setKimiStage）
   mock（无 BFF）分支：时间假进度 0→100% */
var _kimiStageTimers = [];
function setKimiProgress(card, pct, isErr){
  var bar = card.querySelector('.kimi-progress-bar');
  var pctEl = card.querySelector('.kimi-progress-pct');
  var wrap = card.querySelector('.kimi-progress');
  if(!bar || !pctEl) return;
  pct = Math.max(0, Math.min(100, pct));
  bar.style.width = pct + '%';
  pctEl.textContent = Math.round(pct) + '%';
  if(isErr && wrap){ wrap.classList.add('err'); }
}
function renderKimiStage(card, title, stream){
  clearKimiStage();
  card._kimiDeltaChars = 0;
  card.innerHTML =
    '<div class="kimi-stage">'+
      '<div class="ks-bar"><span class="ks-spin"></span><span class="ks-txt">上传中…</span></div>'+
      '<div class="ks-tracks"><div class="ks-tr on"></div><div class="ks-tr"></div><div class="ks-tr"></div></div>'+
      '<div class="ks-sub" style="font-size:10.5px;color:var(--sub)">阶段 1/3 · 加密上传图片</div>'+
      '<div class="kimi-progress"><div class="kimi-progress-bar"></div><span class="kimi-progress-pct">0%</span></div>'+
      '<div class="ks-delta hide"></div>'+
    '</div>';
  card.style.display='block';
  if(stream){ setKimiProgress(card, 5); return; } // SSE 阶段事件驱动进度（upload/recognize/advise/done/error）
  // mock 分支：时间假进度 0→100%（总 2.2s，每 200ms 递增）
  var stages = ['上传中…','识别中…','生成建议中…'];
  var sub = ['阶段 1/3 · 加密上传图片','阶段 2/3 · Kimi 视觉模型识别','阶段 3/3 · 汇总建议与置信度'];
  var txtEl = card.querySelector('.ks-txt');
  var subEl = card.querySelector('.ks-sub');
  var trs = card.querySelectorAll('.ks-tr');
  var pct = 0, tickMs = 200, totalMs = 2200, incr = 100/(totalMs/tickMs);
  setKimiProgress(card, 0);
  _kimiStageTimers.push(setInterval(function(){
    pct = Math.min(100, pct + incr);
    var si = pct < 33 ? 0 : pct < 66 ? 1 : 2;
    if(txtEl) txtEl.textContent = stages[si];
    if(subEl) subEl.textContent = sub[si];
    trs.forEach(function(t,idx){ if(idx<=si){t.classList.add('on');}else{t.classList.remove('on');} });
    setKimiProgress(card, pct);
  }, tickMs));
}
// BFF SSE stage 事件 → 更新等待卡阶段文案 + 进度（upload15/recognize45/advise75）
function setKimiStage(card, stage){
  var map = {
    upload:   ['上传中…','阶段 1/3 · 加密上传图片', 0, 15],
    recognize:['识别中…','阶段 2/3 · Kimi 视觉模型识别', 1, 45],
    advise:   ['生成建议中…','阶段 3/3 · 汇总建议与置信度', 2, 75]
  };
  var p = map[stage]; if(!p) return;
  var txt = card.querySelector('.ks-txt'); if(txt) txt.textContent = p[0];
  var sub = card.querySelector('.ks-sub'); if(sub) sub.textContent = p[1];
  var trs = card.querySelectorAll('.ks-tr');
  trs.forEach(function(t, idx){ if(idx<=p[2]) t.classList.add('on'); else t.classList.remove('on'); });
  setKimiProgress(card, p[3]);
}
// BFF SSE delta 事件 → 等待区底部小字提示「AI 正在输出…」+ 进度 75→95 递增（按已收字符数估）
function appendKimiDelta(card, deltaText){
  var d = card.querySelector('.ks-delta');
  if(!d) return;
  d.classList.remove('hide');
  card._kimiDeltaChars = (card._kimiDeltaChars||0) + (deltaText ? String(deltaText).length : 0);
  var snip = deltaText ? (String(deltaText).length>24 ? String(deltaText).slice(0,24)+'…' : String(deltaText)) : '';
  d.innerHTML = '<b>AI 正在输出…</b> '+snip;
  var pct = 75 + Math.min(20, card._kimiDeltaChars/40);
  setKimiProgress(card, pct);
}
function clearKimiStage(){
  _kimiStageTimers.forEach(clearInterval);
  _kimiStageTimers = [];
}
/* Kimi 失败兜底卡：人工复核 */
function renderKimiFallback(card, type){
  var d = kimiData[type] || {title:'识别',cta:'人工复核'};
  card.innerHTML =
    '<div class="kimi-fallback">'+
      '<b>⚠ Kimi 视觉暂不可用</b><br>已切换为<b>人工复核</b>模式。请人工核对后点下方按钮确认（写操作需确认 → /api/sync）。'+
      '<div style="margin-top:9px"><button class="pbtn alt" onclick="kimiCta(\''+type+'\',\''+d.cta+' · 人工复核\')">'+d.cta+' · 人工复核</button></div>'+
    '</div>';
  card.style.display='block';
}
// 图片压缩为 base64（JPEG, 长边≤maxW）
function fileToBase64(file, maxW){
  return new Promise(function(res, rej){
    var fr = new FileReader();
    fr.onload = function(){
      var img = new Image();
      img.onload = function(){
        var sc = Math.min(1, (maxW||1280) / img.width);
        var c = document.createElement('canvas');
        c.width = img.width * sc; c.height = img.height * sc;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = rej; img.src = fr.result;
    };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
}
// 调云端 BFF：POST {type, imageBase64, ctx} → {ok, result, traceId}
function callKimiVision(type, base64, ctx){
  return fetch(window.KIMI_BFF_URL, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: type, imageBase64: base64, ctx: ctx || {} })
  }).then(function(r){
    if(!r.ok) throw new Error('BFF '+r.status);
    return r.json();
  }).then(function(j){
    if(!j || !j.ok || !j.result) throw new Error('BFF no result');
    return j.result;
  });
}
/* 调云端 BFF 流式接口（SSE）：POST {type,imageBase64,ctx} → 事件流
   - URL = KIMI_BFF_URL + '/stream'（保留 KIMI_BFF_URL 行不变）
   - 通过 response.body.getReader() 读取 POST 流式响应（浏览器支持）
   - 解析按 \n\n 分块，行 event:/data: 分发到 handlers.stage/delta/done/error
   - handlers.stage(stage)/delta(delta)/done(result)/error(error) */
function callKimiVisionStream(type, base64, ctx, handlers){
  var url = window.KIMI_BFF_URL + '/stream';
  return fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ type: type, imageBase64: base64, ctx: ctx || {} })
  }).then(function(r){
    if(!r.ok) throw new Error('BFF stream '+r.status);
    if(!r.body || !r.body.getReader) throw new Error('no stream reader');
    var reader = r.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    function pump(){
      return reader.read().then(function(res){
        if(res.done) return;
        buf += dec.decode(res.value, {stream:true});
        var idx;
        while((idx = buf.indexOf('\n\n')) >= 0){
          var block = buf.slice(0, idx); buf = buf.slice(idx+2);
          var ev = 'message', data = '';
          block.split('\n').forEach(function(line){
            var m1 = line.match(/^event:\s*(.*)$/); if(m1) ev = m1[1].trim();
            var m2 = line.match(/^data:\s*(.*)$/); if(m2) data += m2[1];
          });
          if(!data) continue;
          var json; try{ json = JSON.parse(data); }catch(e){ json = null; }
          if(json != null && handlers[ev]) handlers[ev](json);
        }
        return pump();
      });
    }
    return pump();
  });
}
var _kimiFileInput = null;
function mockScan(el, type){
  el.classList.add('scanning');
  var card = document.getElementById(kimiCardIds[type]);
  if(!card){ el.classList.remove('scanning'); return; }

  // 无 BFF 地址 → 走 mock 演示（保证原型离线可跑）+ 时间假进度 0→100%
  if(!window.KIMI_BFF_URL){
    renderKimiStage(card, kimiData[type].title, false);
    setTimeout(function(){
      setKimiProgress(card, 100);
      clearKimiStage();
      el.classList.remove('scanning');
      renderKimiCard(card, kimiData[type], type);
    }, 2200);
    return;
  }

  // 有 BFF 地址 → 打开相机/相册，拍照后走 SSE 流式接口
  if(!_kimiFileInput){
    _kimiFileInput = document.createElement('input');
    _kimiFileInput.type = 'file';
    _kimiFileInput.accept = 'image/*';
    _kimiFileInput.capture = 'environment';
    _kimiFileInput.style.display = 'none';
    document.body.appendChild(_kimiFileInput);
  }
  _kimiFileInput.value = '';
  _kimiFileInput.onchange = function(){
    var f = _kimiFileInput.files && _kimiFileInput.files[0];
    if(!f){ el.classList.remove('scanning'); return; }
    // 拍照后立即显示分阶段等待（stream 模式：阶段/进度由 BFF SSE 事件驱动）
    renderKimiStage(card, kimiData[type].title, true);
    fileToBase64(f, 1280).then(function(b64){
      return callKimiVisionStream(type, b64, { ts: Date.now(), type: type }, {
        stage: function(j){ if(j && j.stage) setKimiStage(card, j.stage); },
        delta: function(j){ appendKimiDelta(card, j && j.delta ? j.delta : ''); },
        done: function(j){
          setKimiProgress(card, 100);
          clearKimiStage();
          el.classList.remove('scanning');
          if(j && j.ok && j.result){
            var fb = kimiData[type] || {};
            var conf = j.result.conf || (j.result.confidence ? Math.round(j.result.confidence*100)/100 : fb.conf);
            renderKimiCard(card, {
              title: j.result.title || fb.title,
              rows: j.result.rows || fb.rows,
              note: j.result.note || fb.note,
              cta: j.result.cta || fb.cta,
              conf: conf
            }, type);
          } else {
            renderKimiFallback(card, type);
          }
        },
        error: function(j){
          // SSE error 事件 → 进度条变红，提示「已降级为示例」→ 渲染 mock 结果
          console.warn('[Kimi] SSE error 事件，降级 mock：', j);
          el.classList.remove('scanning');
          setKimiProgress(card, 100, true);
          var dErr = card.querySelector('.ks-delta');
          if(dErr){ dErr.classList.remove('hide'); dErr.innerHTML = '<b style="color:var(--red)">⚠ 已降级为示例</b>'; }
          setTimeout(function(){
            clearKimiStage();
            renderKimiCard(card, kimiData[type], type);
          }, 900);
        }
      });
    }).catch(function(err){
      // 流断 / fetch 失败 → 进度条变红，提示「已降级为示例」→ 人工复核卡 + mock 参考
      console.warn('[Kimi] SSE 流式调用失败，降级 mock：', err);
      el.classList.remove('scanning');
      setKimiProgress(card, 100, true);
      var dErr = card.querySelector('.ks-delta');
      if(dErr){ dErr.classList.remove('hide'); dErr.innerHTML = '<b style="color:var(--red)">⚠ 流中断 · 已降级为示例</b>'; }
      setTimeout(function(){
        clearKimiStage();
        renderKimiFallback(card, type);
        var prev = card.querySelector('.kimi-fallback');
        if(prev){
          var note = document.createElement('div');
          note.className='kimi-note';
          note.style.marginTop='8px';
          note.textContent='参考结果（mock）：'+(kimiData[type].note||'');
          if(card.querySelector('.kimi-fallback')) card.querySelector('.kimi-fallback').appendChild(note);
        }
      }, 900);
    });
  };
  _kimiFileInput.click();
}

/* ====== 底部抽屉 ====== */
var sheets = {
  confirm: {
    title:'待办确认 · AI 只读 + 人工确认',
    html: '' // openSheet 时按 payload 由 buildConfirm 动态渲染
  },
  recipe: {
    title:'红色·冬菇荸荠饺 · 非遗配方',
    html: '' // openSheet 时用 buildRecipeHtml（文档原文 + 单独推算块）
  },
  tableBill: {
    title:'桌台账单 · 只读 + 人工结账',
    html:
      '<div class="note">⚠ 桌台账单为只读输出层，结账需人工确认 → /api/sync。</div>'+
      '<div class="card">'+
        '<div class="card-h"><div class="ttl"><i class="em"></i>桌台 #<span id="billNo">01</span> · <span id="billSt">用餐</span></div></div>'+
        '<table class="bill-tbl"><thead><tr><th>菜品</th><th style="text-align:right">数量</th><th style="text-align:right">小计</th></thead><tbody id="billBody"></tbody></table>'+
        '<div class="bill-total"><span>合计</span><span id="billTotal">¥0</span></div>'+
      '</div>'+
      '<div class="card">'+
        '<div class="card-h"><div class="ttl"><i class="em"></i>结账操作</div></div>'+
        '<div class="chip-row"><span class="chip act" onclick="bossConfirmAction(\'pos.checkout\',{channel:\'wechat\'},\'微信结账\')">微信结账</span><span class="chip" onclick="bossConfirmAction(\'pos.checkout\',{channel:\'alipay\'},\'支付宝结账\')">支付宝</span><span class="chip" onclick="bossConfirmAction(\'pos.checkout\',{channel:\'member\'},\'会员储值结账\')">会员储值</span></div>'+
        '<div class="note" style="margin-top:8px">结账入云端确认队列（不直写店内 DB）；桌态可本地演示翻台。</div>'+
      '</div>'
  },
  splitBill: {
    title:'拆单 · 勾选要拆出的菜品',
    html:
      '<div class="note">⚠ 勾选菜品 → 点「选择目标空桌」→ 点击空桌完成拆单。收银操作需确认 → /api/sync。</div>'+
      '<div class="card">'+
        '<div class="card-h"><div class="ttl"><i class="em"></i>源桌 #<span id="splitNo">-</span> · 待拆菜品</div></div>'+
        '<div id="splitBody"></div>'+
        '<div class="bill-total"><span>选中合计</span><span id="splitTotal">¥0</span></div>'+
        '<div class="chip-row" style="margin-top:10px"><span class="chip act" onclick="confirmSplitItems()">选择目标空桌</span><span class="chip" onclick="cancelSplitItems();closeSheet();">取消</span></div>'+
      '</div>'
  },
  matrixDrill: {
    title:'波士顿矩阵 · 象限钻取',
    html:'<div class="card"><div class="card-h"><div class="ttl"><i class="em"></i><span id="mxQ">明星</span>象限 · 菜品清单</div></div><div id="mxList"></div><div class="note" style="margin-top:8px">钻取为只读输出；调价/换位需在菜单管理确认后生效。</div></div>'
  },
  posHistory: {
    title:'并单/拆单 · 操作历史',
    html:'<div class="note">点击任一步可<b>回跳</b>到该状态；当前步高亮，<span style="color:var(--sub)">已撤销的灰显</span>。回跳后该步之后的操作会被截断。</div><div class="card"><div class="card-h"><div class="ttl"><i class="em"></i>时间线</div></div><div id="posHistoryList"></div></div>'
  }
};
function openSheet(k, payload){
  var s = sheets[k];
  if(!s) return;
  var title = s.title;
  var html = s.html;
  _confirmPending = null;
  if(k === 'confirm'){
    var cp = payload || {kind:'generic', title:'今日待办 · 3 项', lines:[['补货转单','火龙果汁/墨鱼汁 · 预估 ¥706'],['结算单审批','供应商张记 · ¥2,180'],['会员生日券','3 位会员本周生日 · 待发券']]};
    var cf = buildConfirm(cp);
    title = cf.title;
    html = cf.html;
    if(cp.actionType) _confirmPending = cp;
  }
  if(k === 'recipe'){
    var item = payload || window.__wufuRecipe || null;
    if(!item){
      // 配方 JSON 未加载：不套兜底红饺配方，避免所有菜谱行张冠李戴
      title = '配方 · 数据未加载';
      html = '<div class="card"><div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.01" stroke-linecap="round"/></svg><div class="et">配方数据未加载</div><div class="ed">菜单配方尚未从云端同步，请联网后下拉刷新重试；未加载完成前不展示兜底配方。</div></div></div>';
    } else {
      var nm = item.name || '红色·冬菇荸荠饺';
      title = nm.replace(/^御字牌五福饺子（/,'').replace(/）$/,'') + ' · 非遗配方';
      if(item.blessing) title = (item.color || '红') + '色 · ' + String(item.filling || '冬菇荸荠饺').replace(/馅$/,'饺') + ' · 非遗配方';
      html = buildRecipeHtml(item);
    }
  }
  document.getElementById('sheetTitle').textContent = title;
  document.getElementById('sheetContent').innerHTML = html;
  document.getElementById('sheetMask').classList.add('on');
  document.getElementById('sheet').classList.add('on');
  if(k==='tableBill' && payload){ fillBill(payload); }
  if(k==='splitBill' && payload){ fillSplit(payload); }
  if(k==='matrixDrill' && payload){ fillMatrix(payload); }
  if(k==='posHistory'){ renderPosHistory(); }
}
function closeSheet(){
  document.getElementById('sheetMask').classList.remove('on');
  document.getElementById('sheet').classList.remove('on');
}

/* ====== confirm 抽屉：按 payload 上下文化渲染 ======
   kind: restock2po 补货转采购 / aiForecast2po AI备货转采购 / salary 薪资审批 /
         birthdayCoupon 生日发券 / settlement 结算单审批 / generic 通用。
   有 actionType 时确认按钮入 actions 队列（POST /api/actions），失败降级 toast「离线，已仅记录」。 */
var _confirmPending = null;
function cfmStat(k, v){
  return '<div class="stat-line"><span>'+escHtml(k)+'</span><span style="text-align:right;max-width:62%;line-height:1.35">'+escHtml(v)+'</span></div>';
}
function buildConfirm(p){
  p = p || {};
  var kind = p.kind || 'generic';
  var title = p.title || '待办确认 · AI 只读 + 人工确认';
  var inner = '';
  if(kind === 'restock2po'){
    title = p.title || '补货转采购 · 人工确认';
    var total = 0, rows = '';
    (p.items || []).forEach(function(it){
      if(typeof it.price === 'number') total += it.price;
      rows += cfmStat(it.name, (it.cur ? '现 '+it.cur+' · ' : '')+(it.suggest || '')+(typeof it.price === 'number' ? ' · ¥'+it.price : ''));
    });
    inner = '<div class="card"><div class="card-h"><div class="ttl"><i class="em"></i>低库存原料 → 采购单</div></div>'+rows+
      (p.vendor ? cfmStat('建议供应商', p.vendor) : '')+
      (total ? '<div class="stat-line"><span>合计预估</span><span><b>¥'+total.toLocaleString('en-US')+'</b></span></div>' : '')+
      '<div class="note" style="margin-top:8px">转单后进采购管理，自动生成 ≠ 自动下单。</div></div>';
    if(!p.actionType) p.actionType = 'restock.create';
    if(!p.actionPayload) p.actionPayload = {items:(p.items||[]).map(function(it){ return it.name; })};
    if(!p.confirmLabel) p.confirmLabel = '确认转单';
  } else if(kind === 'aiForecast2po'){
    title = p.title || 'AI 备货转采购 · 人工确认';
    var ftotal = 0, frows = '';
    (p.items || []).forEach(function(it){
      if(typeof it.price === 'number') ftotal += it.price;
      frows += cfmStat(it.name, (it.range || '')+(typeof it.price === 'number' ? ' · ¥'+it.price : ''));
    });
    inner = '<div class="card"><div class="card-h"><div class="ttl"><i class="em"></i>AI 备货清单 → 采购单</div></div>'+frows+
      (ftotal ? '<div class="stat-line"><span>合计预估</span><span><b>¥'+ftotal.toLocaleString('en-US')+'</b></span></div>' : '')+
      '<div class="note" style="margin-top:8px">备货建议由 AI 生成（天气+历史4周+节假日三因子），<b>预测 ≠ 下单</b>。</div></div>';
    if(!p.actionType) p.actionType = 'forecast.po';
    if(!p.actionPayload) p.actionPayload = {items:(p.items||[]).map(function(it){ return it.name; })};
    if(!p.confirmLabel) p.confirmLabel = '转采购';
  } else if(kind === 'salary'){
    title = p.title || '薪资审批 · 人工确认';
    var stotal = typeof p.total === 'number' ? '¥'+p.total.toLocaleString('en-US') : (p.total || '-');
    inner = '<div class="card"><div class="card-h"><div class="ttl"><i class="em"></i>员工薪资发放</div></div>'+
      cfmStat('发放月份', p.month || '-')+
      cfmStat('发放人数', (p.count != null ? p.count+' 人' : '-'))+
      '<div class="stat-line"><span>发放总额</span><span><b>'+escHtml(stotal)+'</b></span></div>'+
      '<div class="note" style="margin-top:8px">⚠ 审批后进入发放队列，银行代发回单后自动销记。</div></div>';
    if(!p.actionType) p.actionType = 'salary.approve';
    if(!p.actionPayload) p.actionPayload = {month:p.month, count:p.count, total:p.total};
    if(!p.confirmLabel) p.confirmLabel = '审批发放';
  } else if(kind === 'birthdayCoupon'){
    title = p.title || '生日发券 · 人工确认';
    inner = '<div class="card"><div class="card-h"><div class="ttl"><i class="em"></i>会员生日营销</div></div>'+
      cfmStat('会员', (p.member || '-')+(p.level ? ' · '+p.level : ''))+
      (p.members ? cfmStat('会员数', p.members+' 人') : '')+
      cfmStat('券面额', p.face || '8 折券')+
      '<div class="note" style="margin-top:8px">建议：储值会员加赠「长寿红饺一份」；发券后企微自动触达。</div></div>';
    if(!p.actionType) p.actionType = 'vip.birthdayCoupon';
    if(!p.actionPayload) p.actionPayload = {member:p.member, face:p.face};
    if(!p.confirmLabel) p.confirmLabel = '确认发券';
  } else if(kind === 'settlement'){
    title = p.title || '结算单审批 · 人工确认';
    var samt = typeof p.amount === 'number' ? '¥'+p.amount.toLocaleString('en-US') : (p.amount || '-');
    inner = '<div class="card"><div class="card-h"><div class="ttl"><i class="em"></i>结算单审批</div></div>'+
      cfmStat('供应商', p.vendor || '-')+
      '<div class="stat-line"><span>结算金额</span><span><b>'+escHtml(samt)+'</b></span></div>'+
      '<div class="stat-line"><span>对账</span><span class="tag ok">一致</span></div>'+
      '<div class="note" style="margin-top:8px">⚠ 结算单只读输出层，不写 DB；审批后由人工入账。</div></div>';
    if(!p.actionType) p.actionType = 'settlement.approve';
    if(!p.actionPayload) p.actionPayload = {vendor:p.vendor, amount:p.amount};
    if(!p.confirmLabel) p.confirmLabel = '审批通过';
  } else { // generic
    title = p.title || '操作确认';
    inner = '<div class="card"><div class="card-h"><div class="ttl"><i class="em"></i>'+escHtml(p.title || '操作确认')+'</div></div>'+
      (p.desc ? '<div class="note" style="margin-bottom:4px">'+escHtml(p.desc)+'</div>' : '')+
      (p.lines || []).map(function(l){ return cfmStat(l[0], l[1]); }).join('')+
      '</div>';
    if(!p.confirmLabel) p.confirmLabel = p.actionType ? '确认提交' : '知道了';
  }
  var head = '<div class="note">⚠ <b>AI 仅生成建议</b>，自动生成 ≠ 自动下单；结算单只读输出层不写 DB；所有写操作确认后入队（/api/actions）。</div>';
  var btns = '<div class="chip-row" style="margin-top:10px"><span class="chip act" onclick="confirmSheetSubmit()">'+escHtml(p.confirmLabel || '确认提交')+'</span><span class="chip" onclick="closeSheet()">取消</span></div>';
  return { title:title, html:head+inner+btns };
}
function confirmSheetSubmit(){
  var p = _confirmPending;
  if(!p || !p.actionType){ closeSheet(); toast('已确认'); return; }
  _confirmPending = null;
  enqueueBossAction(p.actionType, p.actionPayload || {});
}
function enqueueBossAction(type, payload){
  var token = '';
  try { token = sessionStorage.getItem('boss_app_token') || localStorage.getItem('boss_app_token') || ''; } catch(e){}
  var headers = {'Content-Type':'application/json'};
  if(token) headers['Authorization'] = 'Bearer '+token;
  fetch('/api/actions', { method:'POST', headers:headers, body:JSON.stringify({type:type, payload:payload, operator:'老板'}) })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); })
    .then(function(){ toast('已提交，待确认台处理'); closeSheet(); })
    .catch(function(){ toast('离线，已仅记录'); closeSheet(); });
}

/* ====== Kimi 结果卡 CTA：入库/补货/留样走 confirm 抽屉，其余轻量 toast ====== */
function kimiCta(type, label){
  if(type === 'recv'){
    openSheet('confirm', {kind:'generic', title:'登记入库', desc:'Kimi 验货识别结果登记入库：猪肉前肩 / 雪花粉八星 / 火龙果汁，批次均已溯源、检验合格。', actionType:'recv.stockIn', confirmLabel:'登记入库'});
    return;
  }
  if(type === 'stock'){
    openSheet('confirm', {kind:'restock2po', items:[{name:'火龙果汁', cur:'0.44kg', suggest:'补 2.2kg', price:620}], vendor:'菜篮子'});
    return;
  }
  if(type === 'sample'){
    openSheet('confirm', {kind:'generic', title:'登记留样', desc:'红色长寿饺 · 125g · 48h 留样，到期自动提醒。', actionType:'foodsafe.sample', confirmLabel:'登记留样'});
    return;
  }
  toast((label || '识别结果')+'已记录（仅原型）');
}

/* ====== 模块内快捷跳转 ====== */
function goPosFloor(){
  goModule('pos');
  var p = document.querySelector('#pos-pills .pill[data-sp="pos-floor"]'); if(p) p.click();
  toast('请选择空闲桌台点击开台');
}
function goEqMaintain(){
  goModule('equipment');
  var p = document.querySelector('#eq-pills .pill[data-sp="eq-maintain"]'); if(p) p.click();
}

/* ====== 日期动态化：问候行 / 昨日 / 周排班表头 / 到账日期 / 生日会员 ====== */
(function(){
  var WK = ['日','一','二','三','四','五','六'];
  var now = new Date();
  function pad(n){ return n<10 ? '0'+n : ''+n; }
  function md(d){ return pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
  var gd = document.getElementById('greetDate');
  if(gd) gd.textContent = now.getFullYear()+'年'+(now.getMonth()+1)+'月'+now.getDate()+'日 周'+WK[now.getDay()];
  var yd = new Date(now.getTime()-86400000);
  var yl = document.getElementById('ydayLabel');
  if(yl) yl.textContent = (yd.getMonth()+1)+'月'+yd.getDate()+'日';
  var dow = (now.getDay()+6)%7; // 周一=0
  var mon = new Date(now.getTime()-dow*86400000);
  var sun = new Date(mon.getTime()+6*86400000);
  var wr = document.getElementById('weekRange');
  if(wr) wr.textContent = (mon.getMonth()+1)+'.'+mon.getDate()+'–'+(sun.getMonth()+1)+'.'+sun.getDate();
  var t1 = document.getElementById('t1Date'); if(t1) t1.textContent = md(now)+' 到账';
  var t1b = document.getElementById('t1Date2'); if(t1b) t1b.textContent = md(now)+' 到账';
  var t7 = document.getElementById('t7Date'); if(t7) t7.textContent = md(new Date(now.getTime()+6*86400000))+' 到账';
  var rc = document.getElementById('reconDate'); if(rc) rc.textContent = md(yd);
  [['bd1',-1],['bd2',0],['bd3',1]].forEach(function(pair){
    var el = document.getElementById(pair[0]); if(!el) return;
    var d = new Date(now.getTime()+pair[1]*86400000);
    el.textContent = md(d)+' 周'+WK[d.getDay()]+' · 电话 '+(el.dataset.tel || '');
  });
})();

/* ====== 好评关键词标签：点击切换选中 ====== */
document.querySelectorAll('.toggle-row .tg').forEach(function(t){
  t.addEventListener('click', function(){
    t.classList.toggle('on');
    toast('已'+(t.classList.contains('on') ? '选中' : '取消')+'关键词「'+t.textContent+'」');
  });
});

/* ====== 桌台交互（堂食收银 pos） ======
   桌台数据用 JS 模型 posTables（8 桌，state ∈ 空闲|就餐|待清，items:[{name,price,qty}]）。
   点桌台循环状态/弹账单（normal 模式）与 并单/拆单（merge/split 模式）互斥。
   并单/拆单为收银操作，需确认 → /api/sync（不自动落库）。 */
var TBL_LABEL = {free:'空闲',busy:'用餐',clean:'待清',rsv:'预订'};
var TBL_NEXT = {free:'busy',busy:'clean',clean:'free',rsv:'busy'};
var TBL_ST_CLS = {free:'free',busy:'busy',clean:'clean',rsv:'rsv'};
// 兼容历史 TBL_BILLS（非 posTables 桌台兜底，如旧 rsv 桌台）
var TBL_BILLS = {
  '01':[['红色·长寿饺',2,68],['御膳狮子头',1,36],['米饭',2,4]],'02':[['黑色·三鲜饺',2,68],['五彩大拉皮',1,18]],
  '06':[['黄色·茴香大葱饺',2,64],['功夫水煮鱼',1,68]],'08':[['绿色·猪肉玉米饺',2,64],['桂花酒酿圆子',1,12]],
  '11':[['紫色·猪肉香芹饺',2,66],['五福长寿面',1,28]]
};
/* posTables：8 桌数据模型，部分就餐带 items（price 为单价，qty 为数量，小计=price*qty）。
   id 即 floor data-no；初始与 KPI「5/8」一致：5 就餐 + 1 待清 + 2 空闲。 */
var posTables = [
  {id:'T1', state:'就餐', items:[{name:'红色·长寿饺',price:34,qty:2},{name:'御膳狮子头',price:36,qty:1},{name:'米饭',price:2,qty:2}]},
  {id:'T2', state:'就餐', items:[{name:'黑色·三鲜饺',price:34,qty:2},{name:'五彩大拉皮',price:18,qty:1}]},
  {id:'T3', state:'空闲', items:[]},
  {id:'T4', state:'待清', items:[]},
  {id:'T5', state:'就餐', items:[{name:'黄色·茴香大葱饺',price:32,qty:2},{name:'功夫水煮鱼',price:68,qty:1}]},
  {id:'T6', state:'空闲', items:[]},
  {id:'T7', state:'就餐', items:[{name:'绿色·猪肉玉米饺',price:32,qty:2},{name:'桂花酒酿圆子',price:12,qty:1}]},
  {id:'T8', state:'就餐', items:[{name:'紫色·猪肉香芹饺',price:33,qty:2},{name:'五福长寿面',price:28,qty:1}]}
];
// posTables state → DOM class/key
var POS_ST_KEY = {'空闲':'free','就餐':'busy','待清':'clean'};
var POS_KEY_ST = {'free':'空闲','busy':'就餐','clean':'待清'};
function getPosTable(no){ for(var i=0;i<posTables.length;i++){ if(posTables[i].id===no) return posTables[i]; } return null; }
// 取桌台账单（[name,qty,subtotal] 数组）：posTables 优先，TBL_BILLS 兜底
function getTableBill(no){
  var t = getPosTable(no);
  if(t){
    return t.items.map(function(it){ return [it.name, it.qty, it.price*it.qty]; });
  }
  return TBL_BILLS[no] || null;
}
// 由 posTables 条目同步单个桌台 DOM
function syncTableDOM(t){
  var el = document.querySelector('#floorGrid .tbl[data-no="'+t.id+'"]');
  if(!el) return;
  var key = POS_ST_KEY[t.state] || 'free';
  el.dataset.st = key;
  el.className = 'tbl ' + (TBL_ST_CLS[key]||'free');
  var ts = el.querySelector('.ts'); if(ts) ts.textContent = TBL_LABEL[key];
  // 就餐且带账单 → ts 显示金额，否则状态名
  if(key==='busy' && t.items.length){
    var sum = 0; t.items.forEach(function(it){ sum += it.price*it.qty; });
    if(ts) ts.textContent = '¥'+sum;
  }
}
// 渲染整个平面图
function renderFloor(){
  var grid = document.getElementById('floorGrid'); if(!grid) return;
  grid.innerHTML = posTables.map(function(t){
    var key = POS_ST_KEY[t.state] || 'free';
    var label = TBL_LABEL[key];
    if(key==='busy' && t.items.length){
      var sum = 0; t.items.forEach(function(it){ sum += it.price*it.qty; });
      label = '¥'+sum;
    }
    return '<div class="tbl '+(TBL_ST_CLS[key]||'free')+'" data-no="'+t.id+'" data-st="'+key+'" onclick="onTableClick(this)" oncontextmenu="cycleTable(this);return false"><div class="tn">'+t.id+'</div><div class="ts">'+label+'</div><div class="tick">✓</div></div>';
  }).join('');
  recalcFloor();
}
function recalcFloor(){
  var cnt={free:0,busy:0,clean:0};
  document.querySelectorAll('#floorGrid .tbl').forEach(function(t){cnt[t.dataset.st]=(cnt[t.dataset.st]||0)+1;});
  ['free','busy','clean'].forEach(function(k){var e=document.getElementById('lc-'+k);if(e)e.textContent=cnt[k];});
  // 翻台率 = 基线 + 待清占比 + 用餐偏离修正
  var turn = 3.0 + (cnt.clean*0.2) - (cnt.busy-5)*0.05;
  turn = Math.max(2.4, Math.min(4.0, turn));
  var g=document.getElementById('gTurn'); if(g) g.textContent = turn.toFixed(1);
  var k=document.getElementById('kpiTurn'); if(k) k.innerHTML = turn.toFixed(1)+'<small>次</small>';
}
function cycleTable(el){
  if(posMode!=='normal'){ toast('并拆单模式下不可切换状态，请先取消'); return; }
  var ns = TBL_NEXT[el.dataset.st];
  el.dataset.st = ns;
  el.className='tbl '+(TBL_ST_CLS[ns]||ns);
  var ts = el.querySelector('.ts'); if(ts) ts.textContent = TBL_LABEL[ns];
  // 同步回 posTables（若在模型内）
  var t = getPosTable(el.dataset.no); if(t){ t.state = POS_KEY_ST[ns]||'空闲'; if(ns!=='busy') t.items=[]; }
  recalcFloor();
  toast('桌台 #'+el.dataset.no+' → '+TBL_LABEL[ns]);
}
function onTableClick(el){
  var st = el.dataset.st, no = el.dataset.no;
  if(posMode==='merge'){ toggleMergeSelect(no); return; }
  if(posMode==='split'){ handleSplitClick(no); return; }
  // normal：有账单弹账单，无则循环状态
  var bill = getTableBill(no);
  if(!bill){ cycleTable(el); return; }
  openSheet('tableBill', {no:no, st:st, bill:bill});
}
function fillBill(p){
  var no=document.getElementById('billNo'); if(no) no.textContent=p.no;
  var st=document.getElementById('billSt'); if(st) st.textContent=TBL_LABEL[p.st]||p.st;
  var body=document.getElementById('billBody');
  var total=0;
  if(body){
    body.innerHTML = p.bill.map(function(r){
      total += r[2];
      return '<tr><td>'+r[0]+'</td><td style="text-align:right">×'+r[1]+'</td><td style="text-align:right">¥'+r[2]+'</td></tr>';
    }).join('');
  }
  var tt=document.getElementById('billTotal'); if(tt) tt.textContent='¥'+total;
}
/* ---- 并单 / 拆单 模式机 ----
   posMode: 'normal'|'merge'|'split'
   merge: posMergeSel = [targetNo, sourceNo]（限 2，第一张为并入目标）
   split: posSplitSrc = 源桌号, posSplitItems = 勾选下标数组 */
var posMode = 'normal';
var posMergeSel = [];
var posSplitSrc = null;
var posSplitItems = [];
function setPosStatus(html){
  var e=document.getElementById('posStatus'); if(e) e.innerHTML=html;
}
function setPosBtn(){
  var m=document.getElementById('ptMerge'), s=document.getElementById('ptSplit');
  if(m) m.classList.toggle('on', posMode==='merge');
  if(s) s.classList.toggle('on', posMode==='split');
}
function clearTableSel(){
  document.querySelectorAll('#floorGrid .tbl').forEach(function(t){
    t.classList.remove('sel','mt-target','split-src');
  });
}
function enterMergeMode(){
  if(posMode==='merge'){ exitPosMode(); return; }
  if(posMode!=='normal') exitPosMode();
  posMode='merge'; posMergeSel=[];
  setPosBtn(); clearTableSel();
  setPosStatus('并单模式：<b>选 2 张桌台</b>，第 1 张为目标（保留），第 2 张并入后置空闲');
  toast('并单模式：选 2 张桌台');
}
function enterSplitMode(){
  if(posMode==='split'){ exitPosMode(); return; }
  if(posMode!=='normal') exitPosMode();
  posMode='split'; posSplitSrc=null; posSplitItems=[];
  setPosBtn(); clearTableSel();
  setPosStatus('拆单模式：点 <b>带账单的就餐桌</b> 选择要拆出的菜品');
  toast('拆单模式：点带账单的桌台');
}
function exitPosMode(){
  posMode='normal'; posMergeSel=[]; posSplitSrc=null; posSplitItems=[];
  setPosBtn(); clearTableSel();
  setPosStatus('点击桌台查看账单 · 长按循环状态');
}
function toggleMergeSelect(no){
  var t = getPosTable(no);
  if(!t){ toast('该桌台不在并单范围'); return; }
  if(t.state==='空闲'){ toast('空闲桌无账单，不可并入/被并入'); return; }
  var i = posMergeSel.indexOf(no);
  if(i>=0){
    posMergeSel.splice(i,1);
  } else {
    if(posMergeSel.length>=2){ toast('限选 2 张桌台'); return; }
    posMergeSel.push(no);
  }
  clearTableSel();
  posMergeSel.forEach(function(id, idx){
    var el=document.querySelector('#floorGrid .tbl[data-no="'+id+'"]');
    if(el){ el.classList.add('sel'); if(idx===0) el.classList.add('mt-target'); }
  });
  if(posMergeSel.length<2){
    setPosStatus('并单：已选 '+posMergeSel.length+'/2 · 第 1 张为<b>目标</b>');
    setPosBtn();
  } else {
    setPosStatus('已选 '+posMergeSel[0]+' + '+posMergeSel[1]+' · <b>确认并单</b>：'+posMergeSel[1]+' 并入 '+posMergeSel[0]);
    // 直接执行确认（也可加按钮，这里保持简洁：第二张选中即提示确认）
    confirmMerge();
  }
}
/* 并单/拆单 撤销：操作栈 posUndoStack，每次执行前 push 快照；
   底部 toast 显示「撤销(N)」随步数变化，多步可连续撤销；栈空提示「已到最早状态」。
   可选「重做」posRedoStack：撤销时 push 当前态，新操作清空 redo。旧 lastPosSnapshot 单步快照已废弃。 */
var posUndoStack = [];
var posRedoStack = [];
var _posUndoTimer = null;
function renderUndoBtn(t){
  var n = posUndoStack.length, m = posRedoStack.length;
  var btnU = t.querySelector('.tu-undo'), btnR = t.querySelector('.tu-redo');
  if(btnU){
    btnU.textContent = '撤销('+n+')';
    btnU.disabled = n===0;
    btnU.style.opacity = n===0 ? '.4' : '1';
    btnU.style.cursor = n===0 ? 'not-allowed' : 'pointer';
  }
  if(btnR){
    btnR.textContent = '重做('+m+')';
    btnR.disabled = m===0;
    btnR.style.opacity = m===0 ? '.4' : '1';
    btnR.style.cursor = m===0 ? 'not-allowed' : 'pointer';
  }
  return t.querySelector('.tu-txt');
}
function showPosUndoToast(action){
  var old = document.querySelector('.toast-undo'); if(old && old.parentNode) old.parentNode.removeChild(old);
  if(_posUndoTimer){ clearTimeout(_posUndoTimer); _posUndoTimer = null; }
  var sc = document.querySelector('.screen'); if(!sc) return;
  var n = posUndoStack.length; if(n===0) return;
  var t = document.createElement('div'); t.className='toast-undo';
  t.innerHTML = '<span class="tu-txt">已'+action+' · 可撤销 '+n+' 步</span>'+
    '<button class="tu-btn tu-redo" style="background:#fff;color:var(--ink);border:1.5px solid var(--ink)">重做(0)</button>'+
    '<button class="tu-btn tu-undo">撤销('+n+')</button>';
  sc.appendChild(t);
  renderUndoBtn(t);
  // 栈非空不自动消失，保证多步可连续撤销；栈空后 2s 隐藏
  t.querySelector('.tu-undo').addEventListener('click', function(){
    if(posUndoStack.length===0) return;
    var entry = posUndoStack.pop();
    posRedoStack.push({state: JSON.parse(JSON.stringify(posTables)), label: entry.label, time: entry.time});
    posTables = entry.state;
    renderFloor();
    var txt = renderUndoBtn(t);
    if(posUndoStack.length===0){
      if(txt) txt.textContent = '已到最早状态';
      if(_posUndoTimer) clearTimeout(_posUndoTimer);
      _posUndoTimer = setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); _posUndoTimer = null; }, 2000);
    } else {
      if(txt) txt.textContent = '已撤销 · 还可撤销 '+posUndoStack.length+' 步';
    }
    var ph = document.getElementById('posHistoryList'); if(ph) renderPosHistory();
  });
  t.querySelector('.tu-redo').addEventListener('click', function(){
    if(posRedoStack.length===0) return;
    var entry = posRedoStack.pop();
    posUndoStack.push({state: JSON.parse(JSON.stringify(posTables)), label: entry.label, time: entry.time});
    posTables = entry.state;
    renderFloor();
    var txt = renderUndoBtn(t);
    if(txt) txt.textContent = '已重做 · 还可撤销 '+posUndoStack.length+' 步 / 重做 '+posRedoStack.length+' 步';
    var ph = document.getElementById('posHistoryList'); if(ph) renderPosHistory();
  });
}
function confirmMerge(){
  if(posMergeSel.length<2){ toast('请选 2 张桌台'); return; }
  var a = getPosTable(posMergeSel[0]); var b = getPosTable(posMergeSel[1]);
  if(!a || !b){ toast('桌台数据缺失'); exitPosMode(); return; }
  posUndoStack.push({state: JSON.parse(JSON.stringify(posTables)), label: '并单 '+b.id+'→'+a.id, time: Date.now()}); // 操作栈：执行前 push {state,label,time}
  posRedoStack = []; // 新操作清空 redo
  // 第二桌 items 合并到第一桌，第二桌置空闲
  a.items = a.items.concat(b.items);
  b.items = [];
  b.state = '空闲';
  syncTableDOM(a); syncTableDOM(b);
  recalcFloor();
  toast(b.id+' 已并入 '+a.id+'（需确认→/api/sync）');
  exitPosMode();
  showPosUndoToast('并单');
}
function handleSplitClick(no){
  if(posSplitSrc==null){
    // 选源桌
    var t = getPosTable(no);
    if(!t){ toast('该桌台不在拆单范围'); return; }
    if(t.state!=='就餐' || !t.items.length){ toast('请选带账单的就餐桌'); return; }
    posSplitSrc = no;
    clearTableSel();
    var el=document.querySelector('#floorGrid .tbl[data-no="'+no+'"]');
    if(el) el.classList.add('split-src','sel');
    openSheet('splitBill', {no:no, items:t.items});
  } else {
    // 选目标空桌
    if(no===posSplitSrc){ toast('不能选同一桌'); return; }
    var target = getPosTable(no);
    if(!target){ toast('请选 posTables 内的空桌'); return; }
    if(target.state!=='空闲'){ toast('目标桌需为空闲'); return; }
    var src = getPosTable(posSplitSrc);
    var moved=[], remaining=[];
    src.items.forEach(function(it, i){
      if(posSplitItems.indexOf(i)>=0) moved.push(it); else remaining.push(it);
    });
    if(!moved.length){ toast('未勾选任何菜品'); return; }
    posUndoStack.push({state: JSON.parse(JSON.stringify(posTables)), label: '拆单 '+src.id+'→'+target.id+' 移 '+moved.length+' 项', time: Date.now()}); // 操作栈：执行前 push {state,label,time}
    posRedoStack = []; // 新操作清空 redo
    target.items = target.items.concat(moved);
    target.state = '就餐';
    src.items = remaining;
    if(!src.items.length){ src.state = '待清'; } // 源桌空了置待清
    syncTableDOM(target); syncTableDOM(src);
    recalcFloor();
    toast('已将 '+moved.length+' 项拆到 '+target.id+'（需确认→/api/sync）');
    exitPosMode();
    showPosUndoToast('拆单');
  }
}
function fillSplit(p){
  var noEl=document.getElementById('splitNo'); if(noEl) noEl.textContent=p.no;
  var body=document.getElementById('splitBody');
  if(body){
    body.innerHTML = p.items.map(function(it, i){
      var sub = it.price*it.qty;
      return '<label class="split-item"><input type="checkbox" data-i="'+i+'"><span class="nm">'+it.name+'</span><span class="qt">×'+it.qty+'</span><span class="pr">¥'+sub+'</span></label>';
    }).join('');
    // 勾选联动合计
    body.querySelectorAll('input[type=checkbox]').forEach(function(c){
      c.addEventListener('change', function(){ updateSplitTotal(p.items); });
    });
  }
  var tt=document.getElementById('splitTotal'); if(tt) tt.textContent='¥0';
}
function updateSplitTotal(items){
  var sum=0;
  document.querySelectorAll('#splitBody input[type=checkbox]').forEach(function(c){
    if(c.checked){ var i=parseInt(c.dataset.i); sum += items[i].price*items[i].qty; }
  });
  var tt=document.getElementById('splitTotal'); if(tt) tt.textContent='¥'+sum;
}
function confirmSplitItems(){
  var checks = document.querySelectorAll('#splitBody input[type=checkbox]:checked');
  if(!checks.length){ toast('请勾选要拆出的菜品'); return; }
  posSplitItems = [];
  checks.forEach(function(c){ posSplitItems.push(parseInt(c.dataset.i)); });
  closeSheet();
  setPosStatus('已选 '+posSplitItems.length+' 项 · 点击 <b>目标空桌</b>完成拆单');
  toast('请点击目标空桌');
}
function cancelSplitItems(){
  // 取消拆单选择阶段，回到拆单模式起点
  posSplitSrc=null; posSplitItems=[];
  clearTableSel();
  setPosStatus('拆单模式：点 <b>带账单的就餐桌</b> 选择要拆出的菜品');
}

/* ---- 历史时间线：渲染 + 回跳 ----
   每步快照连同操作描述一起存：posUndoStack/posRedoStack 内为 {state,label,time}
   时间线 = undo 栈(旧→新) + 当前态 + redo 栈(顶→底，灰显)。点任一步回跳。 */
function summarizePosState(state){
  var cnt = {'空闲':0,'就餐':0,'待清':0};
  (state||[]).forEach(function(t){ cnt[t.state] = (cnt[t.state]||0)+1; });
  return '就餐'+(cnt['就餐']||0)+'/待清'+(cnt['待清']||0)+'/空闲'+(cnt['空闲']||0);
}
function fmtPosTime(t){
  if(!t) return '';
  var d = new Date(t);
  function pad(n){return n<10?'0'+n:''+n;}
  return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}
function renderPosHistory(){
  var list = document.getElementById('posHistoryList'); if(!list) return;
  var N = posUndoStack.length, M = posRedoStack.length, html = '';
  for(var i=0;i<N;i++){
    var e = posUndoStack[i];
    html += '<div class="ph-row" onclick="jumpToPosStep('+(i+1)+')">'+
      '<div class="ph-step">'+(i+1)+'</div>'+
      '<div class="ph-info"><div class="ph-op">'+(e.label||'操作')+'</div>'+
      '<div class="ph-meta">'+fmtPosTime(e.time)+' · '+summarizePosState(e.state)+'</div></div>'+
      '</div>';
  }
  // 当前态高亮
  html += '<div class="ph-row ph-cur">'+
    '<div class="ph-step">'+(N+1)+'</div>'+
    '<div class="ph-info"><div class="ph-op">当前状态</div>'+
    '<div class="ph-meta">'+summarizePosState(posTables)+'</div></div>'+
    '<div class="ph-mark">当前</div></div>';
  // redo：从栈顶(最新撤销)到栈底(最早撤销)，灰显
  for(var j=M-1;j>=0;j--){
    var e = posRedoStack[j];
    var stepNo = N+1+(M-j);
    html += '<div class="ph-row ph-redo" onclick="jumpToPosStep('+stepNo+')">'+
      '<div class="ph-step">'+stepNo+'</div>'+
      '<div class="ph-info"><div class="ph-op" style="color:var(--sub)">'+(e.label||'操作')+'</div>'+
      '<div class="ph-meta">'+fmtPosTime(e.time)+' · '+summarizePosState(e.state)+'</div></div>'+
      '</div>';
  }
  if(N===0 && M===0){
    html = '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.01" stroke-linecap="round"/></svg><div class="et">暂无操作历史</div><div class="ed">执行「并单/拆单」后，操作将出现在此时间线</div></div>';
  }
  list.innerHTML = html;
}
function jumpToPosStep(k){
  var N = posUndoStack.length, M = posRedoStack.length;
  if(k<1 || k>N+1+M){ return; }
  if(k<=N){
    // 回跳到 undo 栈第 k 步（保留前 k-1 步），将 k..N 与当前态依次挪入 redo
    while(posUndoStack.length >= k){
      var entry = posUndoStack.pop();
      posRedoStack.push({state: JSON.parse(JSON.stringify(posTables)), label: entry.label, time: entry.time});
      posTables = entry.state;
    }
  } else if(k > N+1){
    // 前跳到 redo 栈第 (k-N-1) 个，将中间态依次挪入 undo
    var steps = k - (N+1);
    while(steps-- > 0 && posRedoStack.length > 0){
      var entry = posRedoStack.pop();
      posUndoStack.push({state: JSON.parse(JSON.stringify(posTables)), label: entry.label, time: entry.time});
      posTables = entry.state;
    }
  }
  renderFloor();
  closeSheet();
  var t = document.querySelector('.toast-undo');
  if(t){ renderUndoBtn(t); var txt=t.querySelector('.tu-txt'); if(txt) txt.textContent='已回到 第'+k+'步 · 可撤销 '+posUndoStack.length+' 步'; }
  toast('已回到 第'+k+'步');
}
renderFloor();

/* ====== 波士顿矩阵钻取 ====== */
var MATRIX_DISHES = {
  star:[['红色·冬菇荸荠饺','销量 486 · 毛利 43.1%','高销高利，建议主推位前置'],['御膳狮子头','销量 312 · 毛利 45%','招牌，可加价 ¥2 测弹性']],
  puzzle:[['黑色·猪肉三鲜饺','销量 413 · 毛利 38.6%','墨鱼汁涨价，试点 +¥0.5'],['五彩大拉皮','销量 268 · 毛利 34%','高销低利，建议优化份量或换供']],
  cow:[['白色·酸菜/牛肉饺','销量 315 · 毛利 42%','低销稳利，中秋可放量'],['五福长寿面','销量 198 · 毛利 41%','主食稳利，搭配套餐']],
  dog:[['紫色·猪肉香芹饺','销量 289 · 毛利 36.2%','低销低利，建议调馅或下架'],['桂花酒酿圆子','销量 142 · 毛利 35%','甜品瘦狗，保留作引流或减 SKU']]
};
function drillMatrix(q){
  var list = MATRIX_DISHES[q] || [];
  var names = {star:'明星',puzzle:'问题',cow:'金牛',dog:'瘦狗'};
  openSheet('matrixDrill', {q:q, list:list, qName:names[q]||q});
}
function fillMatrix(p){
  var q=document.getElementById('mxQ'); if(q) q.textContent=p.qName;
  var list=document.getElementById('mxList');
  if(!list) return;
  if(!p.list.length){
    list.innerHTML='<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M8 12h8" stroke-linecap="round"/></svg><div class="et">暂无菜品</div><div class="ed">该象限暂未匹配到菜品</div></div>';
    return;
  }
  list.innerHTML = p.list.map(function(r){
    return '<div class="rc-row"><div class="info"><div class="ti">'+r[0]+'</div><div class="ds">'+r[1]+'</div></div><span class="tag ok">'+r[2]+'</span></div>';
  }).join('');
}

/* ====== 会员卡展开 ====== */
function toggleVipCard(row){
  row.classList.toggle('open');
}

/* ====== 优惠券状态机 ====== */
var COUPON_FLOW = {pending:'sent', sent:'used', used:'expired', expired:'pending'};
var COUPON_ST_TXT = {pending:'待发',sent:'已发',used:'已用',expired:'过期'};
var COUPON_ST_CLS = {pending:'cc-s-pending',sent:'cc-s-sent',used:'cc-s-used',expired:'cc-s-expired'};
function couponState(cid){ return (document.querySelector('.coupon-card[data-cid="'+cid+'"]')||{}).dataset; }
function cycleCoupon(cid){
  var card=document.querySelector('.coupon-card[data-cid="'+cid+'"]'); if(!card) return;
  var cur=card.dataset.st||'pending';
  var ns=COUPON_FLOW[cur]||'used';
  card.dataset.st=ns;
  var st=card.querySelector('.cc-st');
  if(st){ st.className='cc-st '+COUPON_ST_CLS[ns]; st.textContent=COUPON_ST_TXT[ns]; }
  toast('优惠券 → '+COUPON_ST_TXT[ns]+'（需确认→/api/sync）');
}
function resetCoupon(cid){
  var card=document.querySelector('.coupon-card[data-cid="'+cid+'"]'); if(!card) return;
  card.dataset.st='pending';
  var st=card.querySelector('.cc-st');
  if(st){ st.className='cc-st cc-s-pending'; st.textContent='待发'; }
  toast('优惠券已重置为 待发（需确认→/api/sync）');
}
// 初始化优惠券 data-st
document.querySelectorAll('.coupon-card').forEach(function(c){
  var st=c.querySelector('.cc-st');
  if(st && !c.dataset.st){ for(var k in COUPON_ST_CLS){ if(st.classList.contains(COUPON_ST_CLS[k])){ c.dataset.st=k; } } }
});

/* ====== 更多页：搜索 / 收藏 / 最近访问 ====== */
function renderFavs(){
  var favs = JSON.parse(localStorage.getItem('pf_fav')||'[]');
  var row = document.getElementById('favRow'); if(!row) return;
  if(!favs.length){ row.innerHTML='<div class="mini-chip empty">长按下方模块添加常用</div>'; return; }
  row.innerHTML = favs.map(function(m){
    return '<div class="mini-chip" onclick="goModule(\''+m+'\')"><span class="ic" style="background:#EDE3F4;color:#9B6BBF">★</span>'+(MOD_NAMES[m]||m)+'</div>';
  }).join('');
}
function renderRecent(){
  var row = document.getElementById('recentRow'); if(!row) return;
  if(!recent.length){ row.innerHTML='<div class="mini-chip empty">最近访问的模块将显示在此</div>'; return; }
  row.innerHTML = recent.map(function(m){
    return '<div class="mini-chip" onclick="goModule(\''+m+'\')"><span class="ic" style="background:#E3EDF7;color:#3A6EA5">🕒</span>'+(MOD_NAMES[m]||m)+'</div>';
  }).join('');
}
function toggleFav(m){
  var favs = JSON.parse(localStorage.getItem('pf_fav')||'[]');
  var i = favs.indexOf(m);
  if(i>=0){ favs.splice(i,1); toast('已取消收藏'); }
  else { favs.push(m); toast('已收藏 '+ (MOD_NAMES[m]||m)); }
  localStorage.setItem('pf_fav', JSON.stringify(favs));
  var cell=document.querySelector('.more-cell[data-m="'+m+'"]'); if(cell) cell.classList.toggle('fav');
  renderFavs();
}
function bindMoreSearch(){
  var inp=document.getElementById('moreSearch'), clr=document.getElementById('moreClr');
  var grid=document.getElementById('moreGrid'), empty=document.getElementById('moreEmpty');
  function filter(){
    var q=(inp.value||'').trim().toLowerCase();
    var any=false;
    grid.querySelectorAll('.more-cell').forEach(function(c){
      var txt=(c.textContent||'').toLowerCase();
      var show = !q || txt.indexOf(q)>=0;
      c.style.display = show?'':'none';
      if(show) any=true;
    });
    if(empty){ empty.innerHTML = any ? '' : '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3" stroke-linecap="round"/></svg><div class="et">未找到模块</div><div class="ed">试试「收银」「食安」「对账」</div></div>'; }
  }
  if(inp) inp.addEventListener('input', filter);
  if(clr) clr.addEventListener('click', function(){ if(inp){inp.value='';filter();} });
}
function bindFavLongPress(){
  var tmr=null;
  document.querySelectorAll('.more-cell[data-m]').forEach(function(c){
    function start(){ tmr=setTimeout(function(){ toggleFav(c.dataset.m); }, 650); }
    function cancel(){ if(tmr){ clearTimeout(tmr); tmr=null; } }
    c.addEventListener('touchstart', start, {passive:true});
    c.addEventListener('touchend', cancel);
    c.addEventListener('touchmove', cancel);
    c.addEventListener('mousedown', start);
    c.addEventListener('mouseup', cancel);
    c.addEventListener('mouseleave', cancel);
  });
  var rc=document.getElementById('recentClr');
  if(rc) rc.addEventListener('click', function(){ recent=[]; localStorage.setItem('pf_recent','[]'); renderRecent(); toast('已清空最近访问'); });
}
renderFavs(); renderRecent(); bindMoreSearch(); bindFavLongPress();
// 初始化收藏样式
JSON.parse(localStorage.getItem('pf_fav')||'[]').forEach(function(m){
  var c=document.querySelector('.more-cell[data-m="'+m+'"]'); if(c) c.classList.add('fav');
});

/* ====== 矩阵象限点击 ====== */
document.querySelectorAll('#matrixSvg .quad, .mx-legend .lg').forEach(function(el){
  el.addEventListener('click', function(){ drillMatrix(el.dataset.q); });
});

/* ====== 左滑操作（待办/采购单） ====== */
function bindSwipe(){
  document.querySelectorAll('.swipe-row').forEach(function(row){
    var cnt=row.querySelector('.swipe-cnt'); if(!cnt) return;
    var startX=0, dx=0, dragging=false;
    function down(x){ startX=x; dx=0; dragging=true; }
    function move(x){
      if(!dragging) return;
      dx=Math.max(-130, Math.min(0, x-startX));
      cnt.style.transform='translateX('+dx+'px)';
    }
    function up(){
      if(!dragging) return; dragging=false;
      cnt.style.transform = dx<-60 ? 'translateX(-130px)' : '';
    }
    row.addEventListener('touchstart', function(e){ var t=e.touches[0]; down(t.clientX); });
    row.addEventListener('touchmove', function(e){ var t=e.touches[0]; move(t.clientX); if(dragging && Math.abs(t.clientX-startX)>8) e.preventDefault(); }, {passive:false});
    row.addEventListener('touchend', up);
    row.addEventListener('mousedown', function(e){ down(e.clientX); var mv=function(ev){ move(ev.clientX); }; var u=function(){ up(); document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',u); }; document.addEventListener('mousemove',mv); document.addEventListener('mouseup',u); });
  });
}
bindSwipe();

/* ====== 下拉刷新 ====== */
function bindPtr(){
  var app=document.getElementById('app'); if(!app) return;
  var ptr=document.getElementById('ptr'); if(!ptr) return;
  var startY=0, pulling=false, dy=0;
  function start(y){ startY=y; pulling=app.scrollTop<=0; dy=0; }
  function move(y){
    if(!pulling) return;
    dy=Math.min(80, Math.max(0, y-startY));
    if(dy>0){
      ptr.style.height=dy+'px';
      ptr.classList.remove('hide');
      ptr.querySelector('.txt').textContent = dy>60?'松开刷新':'下拉刷新';
    }
  }
  function end(){
    if(!pulling) return; pulling=false;
    if(dy>60){
      ptr.classList.add('on'); ptr.style.height='';
      ptr.querySelector('.spin').style.display='block';
      ptr.querySelector('.txt').textContent='刷新中…';
      setTimeout(function(){
        ptr.classList.remove('on'); ptr.classList.add('hide');
        ptr.querySelector('.spin').style.display='none';
        ptr.querySelector('.txt').textContent='下拉刷新';
        var sec=app.querySelector('section:not(.hide)');
        triggerSkel(sec);
        if(typeof window.__bossBffRefresh==='function'){
          window.__bossBffRefresh().then(function(){ toast('已刷新'); }).catch(function(){ toast('已刷新（本地数据）'); });
        } else { toast('已刷新'); }
      }, 800);
    } else {
      ptr.style.height=''; ptr.classList.add('hide');
    }
    dy=0;
  }
  app.addEventListener('touchstart', function(e){ if(app.scrollTop<=0) start(e.touches[0].clientY); }, {passive:true});
  app.addEventListener('touchmove', function(e){ if(pulling){ e.preventDefault(); move(e.touches[0].clientY); } }, {passive:false});
  app.addEventListener('touchend', end);
  // 鼠标模拟
  app.addEventListener('mousedown', function(e){
    if(app.scrollTop>0) return;
    start(e.clientY);
    var mv=function(ev){ move(ev.clientY); };
    var up=function(){ end(); document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); };
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
  });
}
bindPtr();

/* ====== AI 问答 ====== */
var aiReply = {
  '上周黑色三鲜饺子毛利多少？':'上周黑色·猪肉三鲜饺销量 413 份，营收 ¥17,768，毛利 38.6%（¥6,858）。墨鱼汁采购价环比 +8%，拉低毛利 1.2pct。建议：①试点 +¥0.5 测试弹性；②询广州海味比价。',
  '今天做500份红饺要多少料？':'按文档本批原料（面粉500g+火龙果汁220g）推算：约67个/批，500个≈7.5批 → 雪花粉约3.73kg、火龙果汁约1.64kg、猪前肩肉约3.73kg、冬菇/荸荠各约0.75kg。文档：剂子10-11g、生饺25-27g。',
  '哪个色毛利最低？为什么？':'毛利最低：紫色·猪肉香芹饺 36.2%。原因：紫薯粉成本占比 18%偏高，且销量 289 份偏瘦狗。建议：①调整馅料降本；②试推变体探需求。',
  '下周该备多少货？':'下周备货建议（基于 4 周趋势 + 节假日）：红饺主推 +8%→备料 540 份量；黑色持平；绿色环比转跌建议减 10%；中秋节团圆白饺 +32%→加备 1.6 倍。详见补货单，需确认后转采购。'
};
window.aiReply = aiReply;
function ask(q){
  var inp = document.getElementById('askInput');
  if(inp) inp.value = q;
  sendAsk();
}
function sendAsk(){
  var inp = document.getElementById('askInput');
  if(!inp) return;
  var q = inp.value.trim();
  if(!q) return;
  var wrap = document.getElementById('chatWrap');
  wrap.insertAdjacentHTML('beforeend',
    '<div class="msg me"><div class="who"><b>我</b></div>'+q+'</div>');
  var a = aiReply[q] || '这个问题我先用结构化数据查一下，可试试问我：上周某色毛利、N 份用量、毛利最低、下周备货。';
  var pandaSrc = document.querySelector('.panda-logo') ? document.querySelector('.panda-logo').src : '';
  wrap.insertAdjacentHTML('beforeend',
    '<div class="msg ai"><div class="who"><img class="panda-logo" src="'+pandaSrc+'" alt=""><b>五福 AI · 在线</b></div>'+a+'</div>');
  inp.value = '';
  wrap.scrollTop = wrap.scrollHeight;
}