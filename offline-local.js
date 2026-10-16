/* 单机服务入口：角色和结算只写本地存档，不连接正式服务器。 */
(function () {
  'use strict';
  const SAVE_KEY = 'yqzd.offline.save.v1';
  // SDK 生命周期改接浏览器，不初始化微信身份或联网 SDK。
  const showListeners = new Set(), hideListeners = new Set();
  globalThis.HSDK = {
    onShow(options) { showListeners.add(typeof options === 'function' ? options : options.listener); },
    onHide(options) { hideListeners.add(typeof options === 'function' ? options : options.listener); },
    offShow(options) { showListeners.delete(typeof options === 'function' ? options : options.listener); },
    offHide(options) { hideListeners.delete(typeof options === 'function' ? options : options.listener); },
    onLogout() {}, setCocosControlAudio() {},
    getSystemInfoSync: () => wx.getSystemInfoSync()
  };
  document.addEventListener('visibilitychange', () => {
    for (const listener of document.hidden ? hideListeners : showListeners) listener?.({query:{},scene:0});
  });
  const state = { defs: null, server: null, configs: null, activeBattle: null, ready: false };
  const result = (data, error = null) => ({ code: error ? -90001 : 0, error, rawData: data, getData: () => data });
  const plain = value => JSON.parse(JSON.stringify(value));
  const now = () => Date.now();
  const remember = () => {
    if (!state.ready) return;
    localStorage.setItem(SAVE_KEY, JSON.stringify({ format: 1, savedAt: now(), role: state.server.ROLE,
      evolutionApplied:state.evolutionApplied }));
  };
  function hydrate(target, data) {
    if (!data) return target;
    if (typeof target.setValue === 'function') { target.setValue(data); return target; }
    Object.assign(target, data); return target;
  }
  function addItem(id, amount) {
    const role = state.server.ROLE;
    if (!Number.isFinite(amount) || amount <= 0) return;
    const item = state.configs.ItemCfg.getById(Number(id));
    if (!item) throw new Error('未知道具 ' + id);
    // 使用配置中的道具类型，避免把货币错误加入普通背包。
    const type = state.configs.ItemType;
    if (item.type === type.GOLD || item.type === type.GOLD_STAGE) role.gold += amount;
    else if (item.type === type.DIAMOND) { role.diamond += amount; role.freeDiamond += amount; }
    else if (item.type === type.STAMINA) role.energy.energyValue += amount;
    else if (item.type === type.SKIN) {
      const skin=state.configs.FashionCfg.getById(item.param[0]);
      if(!skin)throw new Error('傀儡妆奖励配置缺失');
      const levels=skin.partType===state.configs.PartType.ALLBODY?role.fashionSuit.level:role.fashion.level;
      levels.set(skin.id,Math.min(skin.cost.length,(levels.get(skin.id)||0)+amount));
      refreshLocalCardFashionStats();
    }
    else if (item.type === type.EXP) {
      role.exp += amount;
      for(let steps=0;steps<1000;steps++) {
        const level=state.configs.LevelCfg.getById(role.level), next=state.configs.LevelCfg.getById(role.level+1);
        if(!level||!next||level.exp<=0||role.exp<level.exp)break;
        role.exp-=level.exp;role.level++;
        for(const gift of next.reward||[])addItem(gift.item,gift.num);
      }
      LocalWX.status('获得 '+amount+' 经验 · 角色 '+role.level+' 级（'+role.exp+'/'+(state.configs.LevelCfg.getById(role.level)?.exp||0)+'）');
    }
    else {
      const existing = role.bag.get(Number(id));
      if (existing) existing.n += amount;
      else role.bag.set(Number(id), hydrate(new state.defs.GDItem(), { i: Number(id), t: item.type, n: amount }));
    }
  }
  function rewardItem(id, count) {
    const reward = new state.defs.RewardItem();
    reward.rewardType = state.defs.ERewardItemType.item;
    reward.data = hydrate(new state.defs.GDItem(), {i:id,n:count,t:state.configs.ItemCfg.getById(id).type});
    return reward;
  }
  function itemCount(id) {
    const role=state.server.ROLE,type=state.configs.ItemCfg.getById(id)?.type,k=state.configs.ItemType;
    if(type===k.GOLD||type===k.GOLD_STAGE)return role.gold;
    if(type===k.DIAMOND)return role.diamond;
    return role.bag.get(id)?.n||0;
  }
  function consumeItem(id,count) {
    if(count<=0)return;
    const role=state.server.ROLE,type=state.configs.ItemCfg.getById(id)?.type,k=state.configs.ItemType;
    if(type===k.GOLD||type===k.GOLD_STAGE)role.gold-=count;
    else if(type===k.DIAMOND){role.diamond-=count;role.freeDiamond=Math.max(0,role.freeDiamond-count);}
    else role.bag.get(id).n-=count;
  }
  function commitEconomy() {
    // 用独立的增量副本同步背包和货币，避免只改存档而界面不刷新。
    const role=state.server.ROLE,snapshot=plain(role);
    role.setValue({gold:snapshot.gold,diamond:snapshot.diamond,freeDiamond:snapshot.freeDiamond,
      bag:snapshot.bag,exchange:snapshot.exchange,recruit:snapshot.recruit,level:snapshot.level,exp:snapshot.exp,energy:snapshot.energy,hangUp:snapshot.hangUp,stage:snapshot.stage});
    state.uiSignals?.GetHangupSweep.emit();
    remember();
  }
  function exchangeGoods(params) {
    const id=Number(params.goodsId),num=Number(params.num),role=state.server.ROLE;
    const cfg=state.configs.ItemPurchaseCfg.getById(id), item=state.configs.ItemCfg.getById(id);
    if(!cfg||!item)throw new Error('此物品不支持元宝兑换');
    if(params.useRetain)throw new Error('暂不支持存储兑换次数');
    if(!Number.isSafeInteger(num)||num<1||num>9999)throw new Error('兑换数量需要为 1 至 9999');
    const used=role.exchange.get(id)||0,prices=Array.isArray(cfg.price)?cfg.price:[cfg.price];
    if(cfg.dailyLimit>=0&&used+num>cfg.dailyLimit)throw new Error('超过当日兑换次数');
    let cost=0;for(let i=0;i<num;i++)cost+=prices[Math.min(used+i,prices.length-1)];
    const amount=cfg.sendNum*num;
    if(!Number.isSafeInteger(cost)||cost<0||!Number.isSafeInteger(amount)||amount<=0)throw new Error('兑换配置无效');
    if(role.diamond<cost)throw new Error('元宝不足');
    consumeItem(10004,cost);addItem(id,amount);role.exchange.set(id,used+num);commitEconomy();
    return [rewardItem(id,amount)];
  }
  function randomInteger(min,max) {
    const values=new Uint32Array(1);crypto.getRandomValues(values);
    return min+Math.floor(values[0]/4294967296*(max-min+1));
  }
  function drawEntry(ids,weight) {
    const choices=ids.map(id=>state.configs.DrawItemCfg.getById(id)).filter(row=>row&&row[weight]>0);
    const total=choices.reduce((sum,row)=>sum+row[weight],0);
    if(!choices.length||!Number.isFinite(total)||total<=0)throw new Error('本地奖池配置缺失');
    let point=randomInteger(0,2147483646)/2147483647*total;
    for(const row of choices){point-=row[weight];if(point<0)return row;}
    return choices[choices.length-1];
  }
  function recruit(params) {
    const id=Number(params.recruitId),num=Number(params.recruitNumber),role=state.server.ROLE,c=state.configs;
    if(![1,2].includes(id)||Number(params.activityId||0)!==0)throw new Error('此召唤奖池尚未完成本地适配');
    if(![1,10,50,100].includes(num))throw new Error('不支持的召唤次数');
    const cfg=c.DrawCfg.getById(id),current=role.recruit.items.get(id);
    const record=hydrate(new state.defs.GDRecruitItem(),current?plain(current):{});
    if(!record.basePrizeMax)record.basePrizeMax=randomInteger(cfg.basePrizeMaxTime[0],cfg.basePrizeMaxTime[1]);
    if(id===2&&(record.basePrizeCount>0||record.count+num>record.basePrizeMax))throw new Error('新人召唤已结束或剩余次数不足');
    const type=Number(params.recruitType),types=state.defs.ERecruitType;
    // 本地普通/新人召唤免费，不受卦纸、元宝或广告冷却限制。
    const ticketCost=0,diamondCost=0;
    if(![types.ticket,types.diamond,types.free].includes(type))throw new Error('不支持的召唤方式');
    const base=new Map(),coins=new Map(),drawList=[],guaranteedDraws=[];let great=false;
    // 每十抽中的第5/10抽分别保底黄/红天书，占用原抽数；其余八抽保留原奖池。
    const guaranteePools=[0,1].map(rare=>c.DrawCfg.getById(1).basePrizeList.filter(entry=>{
      const row=c.DrawItemCfg.getById(entry),item=c.ItemCfg.getById(row?.Drawid);
      const book=item?.param?.length?c.SkillBookCfg.getById(item.param[0]):null;
      return book?.type===c.SkillBookType.SPECIALCARD&&book.quality===4&&Number(book.isRareSkillBook||0)===rare;
    }));
    function collect(target,row) {
      if(!c.ItemCfg.getById(row.Drawid))throw new Error('抽奖物品配置缺失：'+row.Drawid);
      const count=randomInteger(row.DrawNum[0],row.DrawNum[row.DrawNum.length-1]);
      if(!Number.isSafeInteger(count)||count<1)throw new Error('抽奖数量配置无效');
      target.set(row.Drawid,(target.get(row.Drawid)||0)+count);
    }
    for(let i=0;i<num;i++) {
      let row;
      const forced=(id===2?record.count:record.baseCount)+1>=record.basePrizeMax;
      const position=record.count%10+1,rare=position===5?0:position===10?1:null;
      if(rare!==null) {
        row=drawEntry(guaranteePools[rare],'DrawWeightbasePrize');
        guaranteedDraws.push({count:record.count+1,position,item:row.Drawid,rare});great=true;
      }
      else if(forced)row=drawEntry(cfg.basePrizeList,'DrawWeightbasePrize');
      else if(cfg.prefixN[record.count])row=c.DrawItemCfg.getById(cfg.prefixN[record.count]);
      else if(cfg.guarantBigTime>0&&record.gSuperCount+1>=cfg.guarantBigTime)row=drawEntry(cfg.guarantBigList,'DrawWeightBigguarant');
      else if(cfg.guarantTime>0&&record.guarantyCount+1>=cfg.guarantTime)row=drawEntry(cfg.guarantList,'DrawWeightguarant');
      else row=drawEntry(cfg.baseList,'DrawWeightbase');
      if(!row)throw new Error('抽奖预设配置缺失');
      collect(base,row);drawList.push(row.Id);
      if(cfg.baseCoinList.length)collect(coins,drawEntry(cfg.baseCoinList,'DrawWeightbase'));
      record.count++;record.baseCount++;record.guarantyCount++;record.gSuperCount++;
      if(cfg.guarantList.includes(row.Id))record.guarantyCount=0;
      if(cfg.guarantBigList.includes(row.Id))record.gSuperCount=0;
      if(cfg.basePrizeList.includes(row.Id)||(id===2&&forced)) {
        great=true;record.basePrizeCount++;record.baseCount=0;record.prizeRecord.push(record.count);
        record.basePrizeMax=randomInteger(cfg.basePrizeMaxTime[0],cfg.basePrizeMaxTime[1]);
      }
    }
    // 所有奖项验证完毕后统一发放，再写入存档。
    if(type===types.free)record.lastFreeTime=now();
    role.recruit.items.set(id,record);
    const common=id===1?record:role.recruit.items.get(1);
    if(common)common.weekCount+=num;
    for(const [item,count] of base)addItem(item,count);
    for(const [item,count] of coins)addItem(item,count);
    commitEconomy();
    state.lastRecruit={id,count:num,ticketCost,diamondCost,drawList,guaranteedDraws,baseItems:Array.from(base),coinItems:Array.from(coins),hasGreatReward:great};
    return {baseItems:Array.from(base,([item,count])=>rewardItem(item,count)),coinItems:Array.from(coins,([item,count])=>rewardItem(item,count)),drawList,hasGreatReward:great};
  }
  function upgradeSkill(id) {
    const cfg=state.configs.SkillBookCfg.getById(id), role=state.server.ROLE, types=state.configs.SkillBookType;
    if(!cfg||![types.CARD,types.SPECIALCARD].includes(cfg.type))throw new Error('此符咒类型尚未支持升级');
    const map=cfg.type===types.CARD?role.skill.cardSkillLevel.get(cfg.elementalType):role.skill.epicSkillLevel;
    if(!map)throw new Error('符咒数据缺失');
    const key=cfg.type===types.CARD?cfg.quality:id, level=map.get(key)||0;
    if(level>=cfg.levelMax)throw new Error('符咒已达到最高等级');
    const piece=cfg.pieceItem[level], cost=cfg.cost[level], gold=cfg.goldCost[level];
    if(!Number.isFinite(cost)||!Number.isFinite(gold))throw new Error('符咒升级配置缺失');
    if(itemCount(piece)<cost||role.gold<gold)throw new Error('符咒碎片或铜钱不足');
    consumeItem(piece,cost);role.gold-=gold;map.set(key,level+1);
    const attrs=role.hero.attribute.attributes,k=state.configs.BattleAttributeKey;
    for(const [field,attr] of Object.entries({atkAbs:k.ATK_ABS,hpAbs:k.HP_ABS,atkPct:k.ATK_PCT,hpPct:k.HP_PCT,fireDmg:k.DMG_FIRE,waterDmg:k.DMG_WATER,terraDmg:k.DMG_SOIL,windDmg:k.DMG_WIND,allDmg:k.DMG_ALL,redDmg:k.DMG_RED,PVPDmg:k.DMG_PVP,PVPredDmg:k.DMG_PVP_RED})) {
      const values=cfg[field];if(!values?.length)continue;
      const previous=level>0?(values[level-1]||0):0,next=values[level]??previous;
      attrs.set(attr,(attrs.get(attr)||0)+next-previous);
    }
    attrs.set(k.ATK_V,Math.floor((attrs.get(k.ATK_ABS)||0)*(1+(attrs.get(k.ATK_PCT)||0)/10000)));
    attrs.set(k.HP_V,Math.floor((attrs.get(k.HP_ABS)||0)*(1+(attrs.get(k.HP_PCT)||0)/10000)));
    remember();
  }
  function upgradeHeroAttribute(growId) {
    const role=state.server.ROLE,c=state.configs,d=state.defs;
    const cfg=c.AttrGrowCfg.getById(Number(growId));
    if(!cfg)throw new Error('修炼升级配置不存在');
    const current=role.attrLevel.get(cfg.attrType)||0;
    const limit=c.LevelCfg.getById(role.level)?.attrLimit.get(String(cfg.attrType))||0;
    if(limit<=0)throw new Error('该修炼项目尚未解锁');
    if(current>=limit)throw new Error('已达到当前角色等级的修炼上限');
    if(cfg.level!==current+1)throw new Error('修炼等级已变化，请重试');
    const previous=current>0?c.AttrGrowCfg.list.find(row=>row.attrType===cfg.attrType&&row.level===current):null;
    if(current>0&&!previous)throw new Error('原修炼等级配置缺失');
    if(!Number.isFinite(cfg.stat)||!Number.isSafeInteger(cfg.costCoin)||cfg.costCoin<0)throw new Error('修炼属性或消耗配置无效');
    const costs=new Map([[10003,cfg.costCoin]]);
    for(const item of cfg.costItem||[]) {
      if(!c.ItemCfg.getById(item.item)||!Number.isSafeInteger(item.num)||item.num<0)throw new Error('修炼材料配置无效');
      costs.set(item.item,(costs.get(item.item)||0)+item.num);
    }
    for(const [id,count] of costs)if(itemCount(id)<count)throw new Error(id===10003?'铜钱不足':'修炼材料不足');
    const attrs=role.hero.attribute.attributes,k=c.BattleAttributeKey;
    const weightedPower=()=>{let sum=0;attrs.forEach((value,key)=>{sum+=value*(c.AttrCfg.getById(key)?.power||0)});return sum;};
    const beforePower=weightedPower();
    // 修炼配置的 stat 是累计值，只叠加本次差额，保留存档中的其他属性和手动修改。
    for(const [id,count] of costs)consumeItem(id,count);
    role.attrLevel.set(cfg.attrType,cfg.level);
    attrs.set(cfg.attrType,(attrs.get(cfg.attrType)||0)+cfg.stat-(previous?.stat||0));
    attrs.set(k.ATK_V,Math.floor((attrs.get(k.ATK_ABS)||0)*(1+(attrs.get(k.ATK_PCT)||0)/10000)));
    attrs.set(k.HP_V,Math.floor((attrs.get(k.HP_ABS)||0)*(1+(attrs.get(k.HP_PCT)||0)/10000)));
    let group=role.hero.attribute.moduleAttr.get(d.ModuleAttrType.group);
    if(!group){group=new d.GDModuleAttribute();role.hero.attribute.moduleAttr.set(d.ModuleAttrType.group,group);}
    let data=group.attrData.get(group.curUse);
    if(!data){data=new Map();group.attrData.set(group.curUse,data);}
    data.set(cfg.attrType,cfg.stat);
    const powerDelta=Math.round(weightedPower()-beforePower);
    role.hero.fightPower=Math.max(0,role.hero.fightPower+powerDelta);
    role.fightPower=Math.max(0,role.fightPower+powerDelta);
    role.fightPowerMax=Math.max(role.fightPowerMax,role.fightPower);
    const snapshot=plain(role);
    role.setValue({gold:snapshot.gold,diamond:snapshot.diamond,freeDiamond:snapshot.freeDiamond,bag:snapshot.bag,
      attrLevel:snapshot.attrLevel,hero:snapshot.hero,fightPower:snapshot.fightPower,fightPowerMax:snapshot.fightPowerMax});
    remember();
  }
  function fixedRewards(id,seen=new Set()) {
    return rollConfiguredReward(id,seen);
  }
  function response(options, values = {}) {
    const data = options.respType ? new options.respType() : {};
    Object.assign(data, values);
    if (Object.prototype.hasOwnProperty.call(data, 'role')) data.role = state.server.ROLE;
    return result(data);
  }
  function awakeningNodeUnlocked(nodeId) {
    const role=state.server.ROLE,c=state.configs,node=c.SkillBookEvolutionCfg.getById(nodeId);
    if(!node)return false;
    const book=c.SkillBookCfg.getById(node.skillBookBelong);
    if(!book||(role.skill.epicSkillLevel.get(book.id)||0)<book.levelMax)return false;
    const root=c.SkillBookEvolutionCfg.list.find(x=>x.skillBookBelong===book.id&&x.evolutionPath===1);
    return Boolean(root&&(node.id===root.id||(role.skill.epicAwakening.get(book.id)?.get(root.id)||0)>=root.maxLevel));
  }
  function validateEvolutionApplied(data) {
    if(data===undefined)return {attributes:[],power:0};
    if(!data||!Array.isArray(data.attributes)||!Number.isFinite(data.power)||data.power<0||
      data.attributes.some(x=>!Array.isArray(x)||x.length!==2||!Number.isSafeInteger(x[0])||!Number.isFinite(x[1])))
      throw new Error('存档悟道属性记录无效');
    return data;
  }
  function refreshLocalEvolutionStats() {
    const role=state.server.ROLE,c=state.configs,d=state.defs,next=new Map();let power=0;
    role.skill.epicAwakening.forEach((levels,bookId)=>levels.forEach((level,id)=>{
      const node=c.SkillBookEvolutionCfg.getById(id);
      if(!node||node.skillBookBelong!==bookId||level<1||level>node.maxLevel)return;
      const effect=c.EvolutionSkillCfg.getById(node.evolutionSkillId[level-1]);
      if(!effect)return;
      // 每个节点的当前等级配置已经包含累计属性，不能重复累加此前各级。
      effect.evolutionAttr.forEach((value,key)=>{key=Number(key);next.set(key,(next.get(key)||0)+value);});
      power+=effect.power||0;
    }));
    next.forEach((value,key)=>power+=value*(c.AttrCfg.getById(key)?.power||0));
    power=Math.round(power);
    const previous=state.evolutionApplied||{attributes:[],power:0},old=new Map(previous.attributes);
    let group=role.hero.attribute.moduleAttr.get(d.ModuleAttrType.skill);
    if(!group){group=new d.GDModuleAttribute();role.hero.attribute.moduleAttr.set(d.ModuleAttrType.skill,group);}
    let attrs=group.attrData.get(group.curUse);
    if(!attrs){attrs=new Map();group.attrData.set(group.curUse,attrs);}
    for(const key of new Set([...old.keys(),...next.keys()])) {
      const delta=(next.get(key)||0)-(old.get(key)||0);
      role.hero.attribute.attributes.set(key,(role.hero.attribute.attributes.get(key)||0)+delta);
      attrs.set(key,(attrs.get(key)||0)+delta);
    }
    const delta=power-previous.power;
    role.hero.fightPower=Math.max(0,role.hero.fightPower+delta);
    role.fightPower=Math.max(0,role.fightPower+delta);role.fightPowerMax=Math.max(role.fightPowerMax,role.fightPower);
    // 独立记录已应用值，兼容旧存档补齐，也避免重载和导入时反复叠加。
    state.evolutionApplied={attributes:Array.from(next),power};
  }
  function awakenLocalBook(nodeId) {
    const role=state.server.ROLE,c=state.configs,node=c.SkillBookEvolutionCfg.getById(nodeId);
    if(!node)throw new Error('悟道节点不存在');
    const book=c.SkillBookCfg.getById(node.skillBookBelong);
    if(!book||(role.skill.epicSkillLevel.get(book.id)||0)<book.levelMax)throw new Error('天书满阶后才能顿悟');
    const levels=role.skill.epicAwakening.get(book.id)||new Map(),level=levels.get(nodeId)||0;
    if(level>=node.maxLevel)throw new Error('该悟道节点已达最高等级');
    if(!awakeningNodeUnlocked(nodeId))throw new Error('请先完成此天书的顿悟');
    const effect=c.EvolutionSkillCfg.getById(node.evolutionSkillId[level]);
    if(!effect||(effect.skillId>0&&!c.SkillCfg.getById(effect.skillId)))throw new Error('悟道技能配置缺失');
    // 所有后续节点免费升级，不消耗天书或道具；仍保留各节点最高等级。
    levels.set(nodeId,level+1);role.skill.epicAwakening.set(book.id,levels);
    refreshLocalEvolutionStats();
    const snapshot=plain(role);
    role.setValue({skill:snapshot.skill,hero:snapshot.hero,fightPower:snapshot.fightPower,fightPowerMax:snapshot.fightPowerMax});
    remember();
  }
  function buildBattle(params) {
    const d = state.defs, c = state.configs, role = state.server.ROLE;
    if (params.battleType !== d.EBattleType.stage) throw new Error('此战斗类型尚未完成单机适配');
    const stage = c.StagePointCfg.getById(params.id);
    if (!stage) throw new Error('关卡不存在：' + params.id);
    const cost=stage.stamina * Math.max(1,Math.floor(params.enterRatio||1));
    if(role.energy.energyValue<cost)throw new Error('体力不足');
    const battle = new d.BattleData();
    Object.assign(battle, { id: now(), roleId: role.id, type: params.battleType, stageId: params.id,
      randomSeed: Math.floor(Math.random() * 2147483647), version: env.BATTLE_VERSION, maxRound: 0 });
    const fighter = new d.Fighter();
    Object.assign(fighter, { id: role.hero.id, level: role.hero.level, skin: c.HeroCfg.getById(role.hero.id).avatar,
      attribute: new Map(role.hero.attribute.attributes), equipSkills: new Map(),
      skillLevel: new Map(), skillCombineLevel: new Map(role.skill.combine),
      epicAwakening: new Map(Array.from(role.skill.epicAwakening,([id,levels])=>[id,new Map(levels)])) });
    fighter.hp = fighter.attribute.get(c.BattleAttributeKey.HP_V) || 100;
    // 只放入当前方案的符咒变体，保证三张同符能匹配原引擎的合成规则。
    for (const id of state.roleHelper.getCurPlanCardSkillList()) {
      const skill = c.SkillBookCfg.getById(id);
      if (!skill) throw new Error('当前方案包含未知符咒：' + id);
      const levels = role.skill.cardSkillLevel.get(skill.elementalType);
      if (levels) fighter.skillLevel.set(skill.id, levels.get(skill.quality) || 1);
    }
    fighter.skillLevel.set(c.HeroCfg.getById(role.hero.id).commonSkill, 1);
    fighter.equipSkills.set(c.HeroCfg.getById(role.hero.id).commonSkill, 1);
    role.skill.epicSkillLevel.forEach((level, id) => fighter.skillLevel.set(id, level));
    role.skill.equipSkill.forEach(id => fighter.equipSkills.set(id, role.skill.epicSkillLevel.get(id) || 1));
    addLocalFashionBattleData(fighter);
    battle.leftTeam.roleId = role.id;
    battle.leftTeam.name = role.userInfo.name;
    battle.leftTeam.power = role.fightPower;
    battle.leftTeam.team.set(1, fighter);
    state.activeBattle = { id: battle.id, stageId: params.id, seed: battle.randomSeed, staminaCost:cost };
    role.energy.energyValue -= cost;
    role.stage.battleId = battle.id;
    role.stage.battleType = params.battleType;
    role.stage.enterAt = now();
    role.stage.enterRatio = Math.max(1, Math.floor(params.enterRatio || 1));
    remember();
    return battle;
  }
// 将本文件内函数插入 offline-local.js 的闭包内；依赖现有 state/plain/remember/itemCount/consumeItem/addItem/randomInteger。
function refreshLocalCardFashionStats() {
  const r=state.server.ROLE,c=state.configs,d=state.defs,attrs=r.hero.attribute.attributes;
  const weighted=()=>{let n=0;attrs.forEach((v,k)=>n+=v*(c.AttrCfg.getById(k)?.power||0));return n;};
  const before=weighted(),card=new Map(),fashion=new Map(),cardSkills=new Map(),fashionSkills=new Map(),suitSkills=new Map();
  const add=(map,k,v)=>map.set(Number(k),(map.get(Number(k))||0)+Number(v));
  r.attrCard.cardLevel.forEach((level,id)=>{const cfg=c.AttrCardCfg.getById(id);if(!cfg||!level)return;add(card,cfg.attrType,cfg.stat*level);const skill=cfg.skillId[Math.min(level,cfg.skillId.length)-1];if(skill)cardSkills.set(skill,1);});
  r.fashion.level.forEach((level,id)=>{
    const cfg=c.FashionCfg.getById(id);if(!cfg||!level||cfg.partType===c.PartType.ALLBODY)return;
    if(cfg.activeType!==0&&r.fashion.onUse.get(cfg.partType)!==id)return;
    cfg.attrs[Math.min(level,cfg.attrs.length)-1]?.forEach((v,k)=>add(fashion,k,v));
    for(const skill of cfg.skill[Math.min(level,cfg.skill.length)-1]||[])fashionSkills.set(skill,1);
  });
  r.fashionSuit.level.forEach((level,id)=>{
    const cfg=c.FashionCfg.getById(id);if(!cfg||!level)return;
    cfg.attrs[Math.min(level,cfg.attrs.length)-1]?.forEach((v,k)=>add(fashion,k,v));
    for(const skill of cfg.skill[Math.min(level,cfg.skill.length)-1]||[])suitSkills.set(skill,1);
  });
  for(const [type,next] of [[d.ModuleAttrType.card,card],[d.ModuleAttrType.fashion,fashion]]) {
    let group=r.hero.attribute.moduleAttr.get(type);
    if(!group){group=new d.GDModuleAttribute();r.hero.attribute.moduleAttr.set(type,group);}
    const previous=group.attrData.get(group.curUse)||new Map();
    const keys=new Set([...previous.keys(),...next.keys()]);
    for(const key of keys)attrs.set(Number(key),(attrs.get(Number(key))||0)-(previous.get(key)||0)+(next.get(Number(key))||0));
    group.attrData.set(group.curUse,next);
  }
  r.attrCard.attrSkill=cardSkills;r.fashion.attrSkill=fashionSkills;r.fashionSuit.attrSkill=suitSkills;
  const k=c.BattleAttributeKey;
  attrs.set(k.ATK_V,Math.floor((attrs.get(k.ATK_ABS)||0)*(1+(attrs.get(k.ATK_PCT)||0)/10000)));
  attrs.set(k.HP_V,Math.floor((attrs.get(k.HP_ABS)||0)*(1+(attrs.get(k.HP_PCT)||0)/10000)));
  const delta=Math.round(weighted()-before);r.hero.fightPower=Math.max(0,r.hero.fightPower+delta);
  r.fightPower=Math.max(0,r.fightPower+delta);r.fightPowerMax=Math.max(r.fightPowerMax,r.fightPower);
}
function commitLocalCardFashion() {
  refreshLocalCardFashionStats();
  const r=state.server.ROLE,s=plain(r);
  r.setValue({attrCard:s.attrCard,fashion:s.fashion,fashionSuit:s.fashionSuit,hero:s.hero,
    gold:s.gold,diamond:s.diamond,freeDiamond:s.freeDiamond,bag:s.bag,
    fightPower:s.fightPower,fightPowerMax:s.fightPowerMax});
  remember();
}
function unlockLocalCosmetics() {
  const r=state.server.ROLE,c=state.configs;
  // 一次性迁移只补充拥有状态，保留玩家选择的散件、套装和幻化。
  for(const cfg of c.FashionCfg.list) {
    const levels=cfg.partType===c.PartType.ALLBODY?r.fashionSuit.level:r.fashion.level;
    if((levels.get(cfg.id)||0)<=0)levels.set(cfg.id,1);
  }
  commitLocalCardFashion();
}
function changeLocalCosmetics(cmd,p) {
  const r=state.server.ROLE,c=state.configs,id=Number(p.id||0),cfg=c.FashionCfg.getById(id);
  if(cmd==='hero_fashiontakeon') {
    if(!cfg||cfg.partType===c.PartType.ALLBODY||!r.fashion.level.get(id))throw new Error('傀儡妆不存在');
    const previous=r.fashion.onUse.get(cfg.partType);
    r.fashion.onUse.set(cfg.partType,id);
    if(!r.fashion.onShow.get(cfg.partType)||r.fashion.onShow.get(cfg.partType)===previous)r.fashion.onShow.set(cfg.partType,id);
    if(cfg.partType!==c.PartType.CURTAIN)r.fashionSuit.show.flag=0;
  } else if(cmd==='hero_fashiononshow') {
    const entries=p.show instanceof Map?[...p.show]:Object.entries(p.show||{});
    for(const [part,value] of entries){const row=c.FashionCfg.getById(Number(value));if(!row||row.partType!==Number(part)||!r.fashion.level.get(Number(value)))throw new Error('幻化选择无效');}
    for(const [part,value] of entries)r.fashion.onShow.set(Number(part),Number(value));
  } else if(cmd==='hero_fashionsuitshow') {
    if(id&&(!cfg||cfg.partType!==c.PartType.ALLBODY||!r.fashionSuit.level.get(id)))throw new Error('套装不存在');
    if(![0,1,2].includes(Number(p.sex))||!Number.isInteger(p.flag)||p.flag<0||p.flag>3)throw new Error('套装参数无效');
    r.fashionSuit.show.suitId=id;r.fashionSuit.show.sex=Number(p.sex);r.fashionSuit.show.flag=id?p.flag:0;
  } else {
    const levels=cmd==='hero_fashionsuitlevelup'?r.fashionSuit.level:r.fashion.level;
    if(!cfg||(cmd==='hero_fashionsuitlevelup')!==(cfg.partType===c.PartType.ALLBODY))throw new Error('傀儡妆升级参数无效');
    const level=levels.get(id)||0;
    if(level>=cfg.cost.length)throw new Error('已达傀儡妆满阶');
    // 用户要求全部解锁并自由选装，本地升级无需消耗正式服活动材料。
    levels.set(id,level+1);
  }
  commitLocalCardFashion();
}
function addLocalFashionBattleData(fighter) {
  const r=state.server.ROLE,c=state.configs,d=state.defs;
  fighter.fashion=new Map(r.fashion.onUse);
  fighter.onShow=new Map(r.fashion.onShow);
  const look=r.fashionSuit.show;
  fighter.suitShow=hydrate(new d.GDFashionSuitShow(),plain(look));
  for(const skills of [r.attrCard.attrSkill,r.fashion.attrSkill,r.fashionSuit.attrSkill])skills.forEach((level,id)=>{fighter.equipSkills.set(id,level);fighter.skillLevel.set(id,level);});
  const suit=look.suitId&&((look.flag&(1<<d.FashionSuitFlagBit.skill))!==0)?c.FashionCfg.getById(look.suitId):null;
  const weapon=c.FashionCfg.getById(r.fashion.onUse.get(c.PartType.WEAPON));
  const attackCfg=suit||weapon;
  if(attackCfg) {
    fighter.equipSkills.delete(c.HeroCfg.getById(r.hero.id).commonSkill);
    const level=(suit?r.fashionSuit.level.get(suit.id):r.fashion.level.get(weapon.id))||1;
    for(const id of attackCfg.attackSkill[Math.min(level,attackCfg.attackSkill.length)-1]||[]){fighter.equipSkills.set(id,1);fighter.skillLevel.set(id,1);}
  }
}
function ghostDrawCost(times,group) {
  const c=state.configs;
  const rows=c.AttrCostCfg.list.filter(row=>Number(group)===1?row.cost>0:Number(group)===2?row.costTwo>0:row.costThree>0);
  const row=rows[Math.min(times,rows.length-1)];
  if(!row)throw new Error('鬼店价格配置缺失');
  return {row,cost:Number(group)===1?row.cost:Number(group)===2?row.costTwo:row.costThree};
}
function ghostBatchCost(times,group,num=10) {
  let cost=0;
  for(let i=0;i<num;i++)cost+=ghostDrawCost(times+i,group).cost;
  return cost;
}
function ghostGroupRecord(group) {
  const r=state.server.ROLE;
  if(group===1)return r.attrCard;
  let record=r.attrCard.record.get(group);
  if(!record){record=new state.defs.GDAttrCardRecord();r.attrCard.record.set(group,record);}
  return record;
}
function ghostPick(group,type,exclude=[]) {
  const c=state.configs,r=state.server.ROLE;
  let pool=c.AttrCardCfg.list.filter(row=>row.group===group&&row.attrCardType===type&&row.weight>0&&!exclude.includes(row.id));
  const notFull=pool.filter(row=>(r.attrCard.cardLevel.get(row.id)||0)<row.levelMax[row.levelMax.length-1]);
  if(notFull.length)pool=notFull;
  if(!pool.length)throw new Error('鬼店奖池配置缺失');
  const sum=pool.reduce((n,row)=>n+row.weight,0);let ticket=randomInteger(0,2147483646)/2147483647*sum;
  for(const row of pool){ticket-=row.weight;if(ticket<0)return row;}
  return pool[pool.length-1];
}
function ghostGrantCard(id) {
  const r=state.server.ROLE,cfg=state.configs.AttrCardCfg.getById(id);
  const before=r.attrCard.cardLevel.get(id)||0,max=cfg.levelMax[cfg.levelMax.length-1];
  let shards=r.attrCard.cardShard.get(id)||0;
  if(cfg.num>0){shards++;if(shards>=cfg.num&&before<max){r.attrCard.cardLevel.set(id,before+1);shards-=cfg.num;}r.attrCard.cardShard.set(id,shards);}
  else if(before<max)r.attrCard.cardLevel.set(id,before+1);
  else r.attrCard.cardShard.set(id,shards+1);
}
function drawLocalGhostCard(p,ad=false) {
  const r=state.server.ROLE,c=state.configs,group=Number(p.cardGroup||1),type=Number(p.cardType||1);
  if(![1,2,3].includes(group)||![1,2].includes(type))throw new Error('鬼店抽取参数无效');
  if(type===2) {
    const cost=c.ConstantCfg.config.attrGrowCostSp[0];
    if(itemCount(cost.item)<cost.num)throw new Error('五帝钱不足');
    const a=ghostPick(group,2),b=ghostPick(group,2,[a.id]);
    const record=ghostGroupRecord(group);
    consumeItem(cost.item,cost.num);record.spCards=[a.id,b.id];record.spTimesTotal++;
    commitLocalCardFashion();return [a.id,b.id];
  }
  const num=ad?1:Number(p.num??1);
  if(![1,10].includes(num))throw new Error('鬼店购买次数无效');
  const times=group===1?r.attrCard.timesTotal:(r.attrCard.record.get(group)?.timesTotal||0);
  const total=ad?0:ghostBatchCost(times,group,num);
  if(!ad&&r.gold<total)throw new Error('铜钱不足');
  const record=ghostGroupRecord(group),cards=[];
  // 先验证十次合计价格，再逐次发卡和计算五帝钱进度，最后统一保存。
  if(!ad)consumeItem(10003,total);
  for(let i=0;i<num;i++) {
    const price=ghostDrawCost(record.timesTotal,group);
    const prefix=group===1&&record.timesTotal<c.AttrCostCfg.list.length?price.row.prefixN:0;
    const row=c.AttrCardCfg.getById(prefix)||ghostPick(group,1);
    record.times++;record.timesTotal++;ghostGrantCard(row.id);cards.push(row.id);
    if(record.timesTotal%c.ConstantCfg.config.attrGrowNumReward[group-1]===0)addItem(10006,1);
  }
  // 不累加每日广告已用次数，领取按钮可反复使用。
  commitLocalCardFashion();return cards;
}
function chooseLocalGhostCard(id) {
  const r=state.server.ROLE,cfg=state.configs.AttrCardCfg.getById(Number(id));
  if(!cfg)throw new Error('鬼店选择无效');
  const record=ghostGroupRecord(cfg.group);
  if(!record.spCards.includes(cfg.id))throw new Error('请先抽取五帝钱二选一奖励');
  ghostGrantCard(cfg.id);record.spCards=[];commitLocalCardFashion();
}


// 挂机按配置速率结算，余下不足一件的部分保留，避免频繁领取丢失收益。
function claimHangUp() {
  const role=state.server.ROLE,c=state.configs,constant=c.ConstantCfg.config;
  const cfg=c.StagePointCfg.getById(state.roleHelper.getCurChallengeStageId());
  if(!cfg)throw new Error('挂机章节配置不存在');
  // 旧初始存档 lastRewardTime=0，原界面已显示满上限；按同样上限结算一次。
  const end=now(),last=Math.max(0,Number(role.hangUp.lastRewardTime)||0);
  const elapsed=Math.min(constant.HangUpTimeMax,Math.max(0,Math.floor((end-last)/1000)));
  if(elapsed<constant.HangUpRewardPeriod)throw new Error('挂机时间过短，请稍后再来');
  const units=Math.floor(elapsed/constant.HangUpTimeUnit),items=[],remainders=new Map();
  if(units<=0)throw new Error('暂无可领取的挂机奖励');
  for(const entry of cfg.timereward||[]) {
    const value=(role.hangUp.rewardItems.get(entry.item)||0)+entry.num*units;
    if(!c.ItemCfg.getById(entry.item)||!Number.isSafeInteger(value)||value<0)throw new Error('挂机奖励配置无效');
    const count=Math.floor(value/10000);remainders.set(entry.item,value%10000);
    if(count)items.push({id:entry.item,count});
  }
  for(const entry of items)addItem(entry.id,entry.count);
  role.hangUp.rewardItems=remainders;
  // 仅消耗完整计奖周期，保留尚不足一分钟的时间；达到上限时清除溢出时间。
  role.hangUp.lastRewardTime=(end-last>=constant.HangUpTimeMax*1000)?end:last+units*constant.HangUpTimeUnit*1000;
  commitEconomy();
  return items.map(entry=>rewardItem(entry.id,entry.count));
}

// 按原配置权重抽取一次；Fixed全发，Once2只取一个结果。
function rollConfiguredReward(id,seen=new Set()) {
  if(seen.has(id))throw new Error('奖励配置存在循环');seen.add(id);
  const cfg=state.configs.RewardCfg.getById(id);
  if(!cfg||!['Fixed','Once2'].includes(cfg.randomType))throw new Error('此奖励类型尚未支持本地结算');
  const choices=[];
  cfg.content.forEach(group=>group.forEach((rows,weight)=>choices.push({rows,weight:Number(weight)})));
  let selected=choices;
  if(cfg.randomType==='Once2') {
    const weighted=choices.filter(entry=>Number.isFinite(entry.weight)&&entry.weight>0);
    const total=weighted.reduce((sum,entry)=>sum+entry.weight,0);
    if(!weighted.length||!Number.isSafeInteger(total))throw new Error('随机奖励权重无效');
    let point=randomInteger(1,total),chosen=weighted[weighted.length-1];
    for(const entry of weighted){point-=entry.weight;if(point<=0){chosen=entry;break;}}
    selected=[chosen];
  }
  const output=[];
  for(const entry of selected)for(const item of entry.rows) {
    if(item.type===9)output.push(...rollConfiguredReward(item.code,new Set(seen)));
    else {
      if(!state.configs.ItemCfg.getById(item.code)||!Number.isSafeInteger(item.amount)||item.amount<0)throw new Error('奖励道具配置无效');
      if(item.amount)output.push({id:item.code,count:item.amount});
    }
  }
  return output;
}

// 本地扫荡不限制每日次数，仍按界面展示的体力与原关卡掉落结算。
function sweepHangUp(params) {
  const role=state.server.ROLE,c=state.configs,constant=c.ConstantCfg.config;
  const times=Number(params.times||1);
  if(!constant.HangUpTimes.includes(times))throw new Error('扫荡倍数无效');
  const wave=role.stage.levelStage.waveId,phase=c.StagePhaseCfg.getById(wave);
  if(!phase||!phase.SweepRewardId)throw new Error('尚无可扫荡的通关进度');
  const prices=constant.HangUpSweepCost;
  const perSweep=prices.length?prices[Math.min(role.hangUp.sweepNum,prices.length-1)]:0;
  const cost=perSweep*times;
  if(!Number.isSafeInteger(cost)||cost<0)throw new Error('扫荡体力配置无效');
  if(role.energy.energyValue<cost)throw new Error('体力不足');
  const rewards=new Map();
  for(let i=0;i<times;i++) {
    const ids=[phase.SweepRewardId,...(phase.SweepProbId||[]),...(phase.SweepRareRewardID||[])];
    for(const id of ids)for(const item of rollConfiguredReward(id))rewards.set(item.id,(rewards.get(item.id)||0)+item.count);
  }
  const exp=cost*constant.strengthExp;
  if(exp>0)rewards.set(10001,(rewards.get(10001)||0)+exp);
  role.energy.energyValue-=cost;
  role.hangUp.sweepNum+=times;
  for(const [id,count] of rewards)addItem(id,count);
  commitEconomy();
  return Array.from(rewards).filter(([id])=>id!==10001).map(([id,count])=>rewardItem(id,count));
}

  // 本地见面礼和鬼市使用原配置奖励，全部可重复领取，不进入广告或支付流程。
  const LOCAL_FIRST_GIFT_IDS=new Set([201,202,203,211,212,213,221,222,223]);
  function isRepeatableMallGood(id) {
    const cfg=state.configs.MallConfig.getById(Number(id));
    return !!cfg&&(LOCAL_FIRST_GIFT_IDS.has(cfg.id)||[701,301,601,501].includes(cfg.shopType));
  }
  function prepareLocalMall(refresh=false) {
    for(const cfg of state.configs.MallConfig.list)if(isRepeatableMallGood(cfg.id))cfg.conditions.clear();
    const market=state.server.ROLE.shop.blackMarket;
    const goods=state.configs.RandomMallConfig.list;
    if(refresh)market.refreshCount++;
    // 原界面只容纳五件商品；无限刷新轮换全部商品，避免一次塞满后遮住两侧。
    if(refresh||market.discounts.size!==Math.min(5,goods.length)) {
      market.discounts.clear();
      for(let i=0;i<Math.min(5,goods.length);i++) {
        const cfg=goods[(market.refreshCount*5+i)%goods.length];
        market.discounts.set(cfg.id,Math.max(1,cfg.limit||1));
      }
    } else market.discounts.forEach((left,id)=>market.discounts.set(id,Math.max(1,left)));
    market.refreshTime=now();
  }
  function commitLocalMall() {
    const role=state.server.ROLE,snapshot=plain(role);
    role.setValue({gold:snapshot.gold,diamond:snapshot.diamond,freeDiamond:snapshot.freeDiamond,
      exp:snapshot.exp,level:snapshot.level,energy:snapshot.energy,bag:snapshot.bag,
      shop:snapshot.shop,skill:snapshot.skill,fashion:snapshot.fashion});
    state.uiSignals?.GetHangupSweep.emit();
    remember();
  }
  function resolveLocalGiftItems(input,depth=0) {
    if(depth>12)throw new Error('本地随机道具配置递归过深');
    const out=new Map(),c=state.configs;
    const collect=(id,count)=>out.set(id,(out.get(id)||0)+count);
    for(const row of input) {
      const cfg=c.ItemCfg.getById(row.id);
      if(!cfg||!Number.isSafeInteger(row.count)||row.count<=0)throw new Error('商品奖励配置无效');
      if(cfg.type===c.ItemType.ITEM_RANDOM&&cfg.useType===c.UseType.AUTO) {
        if(!cfg.param?.length||row.count>100000)throw new Error('随机道具数量或配置无效');
        const picked=new Map();
        for(let i=0;i<row.count;i++) {const id=cfg.param[randomInteger(0,cfg.param.length-1)];picked.set(id,(picked.get(id)||0)+1);}
        for(const [id,count] of resolveLocalGiftItems([...picked].map(([id,count])=>({id,count})),depth+1))collect(id,count);
      } else collect(row.id,row.count);
    }
    return out;
  }
  function grantLocalGiftItems(items) {
    const resolved=resolveLocalGiftItems(items);
    for(const [id,count] of resolved)addItem(id,count);
    commitLocalMall();
    return [...resolved].map(([id,count])=>rewardItem(id,count));
  }
  function buyLocalMall(params,blackMarket=false) {
    const id=Number(params.goodsId),num=Number(params.num??1),c=state.configs;
    if(!Number.isSafeInteger(num)||num<1||num>9999)throw new Error('领取数量需要为 1 至 9999');
    const cfg=blackMarket?c.RandomMallConfig.getById(id):c.MallConfig.getById(id);
    if(!cfg||(!blackMarket&&!isRepeatableMallGood(id)))throw new Error('该商品尚未完成本地适配');
    const items=blackMarket?cfg.reward.map(x=>({id:x.item,count:x.num*num})):fixedRewards(cfg.reward.id).map(x=>({id:x.id,count:x.count*num}));
    return grantLocalGiftItems(items);
  }
  function useLocalBagItem(params) {
    const id=Number(params.id),num=Number(params.num),c=state.configs,role=state.server.ROLE,cfg=c.ItemCfg.getById(id);
    if(!cfg||!Number.isSafeInteger(num)||num<1||num>99999)throw new Error('使用道具数量无效');
    if((role.bag.get(id)?.n||0)<num)throw new Error('背包道具数量不足');
    let items=[];
    if(cfg.type===c.ItemType.ITEM_RANDOM) {
      if(!cfg.param?.length)throw new Error('随机道具配置缺失');
      const picked=new Map();for(let i=0;i<num;i++){const target=cfg.param[randomInteger(0,cfg.param.length-1)];picked.set(target,(picked.get(target)||0)+1);}
      items=[...picked].map(([id,count])=>({id,count}));
    } else if(cfg.type===c.ItemType.ITEM_PIECE) {
      const [cost,target]=cfg.param||[];
      if(!Number.isSafeInteger(cost)||cost<1||!target||num%cost!==0)throw new Error('残页数量不足一次完整合成');
      items=[{id:target,count:num/cost}];
    } else if(cfg.type===c.ItemType.ITEM_CHOOSE) {
      const selected=params.itemParams instanceof Map?params.itemParams:new Map(Array.isArray(params.itemParams)?params.itemParams:Object.entries(params.itemParams||{}).map(([id,count])=>[Number(id),count]));
      let total=0;
      for(const [target,count] of selected){if(!cfg.param.includes(Number(target))||!Number.isSafeInteger(count)||count<1)throw new Error('自选道具选择无效');total+=count;items.push({id:Number(target),count});}
      if(total!==num)throw new Error('自选道具数量不匹配');
    } else if(cfg.type===c.ItemType.BOX&&cfg.rewardId)items=fixedRewards(cfg.rewardId.id||cfg.rewardId).map(x=>({id:x.id,count:x.count*num}));
    else throw new Error('此道具类型尚未完成本地使用适配');
    // 先解析和验证全部产物，再扣除背包，避免错误配置吞掉道具。
    const resolved=resolveLocalGiftItems(items);
    role.bag.get(id).n-=num;
    for(const [target,count] of resolved)addItem(target,count);
    commitLocalMall();
    return [...resolved].map(([id,count])=>rewardItem(id,count));
  }
  function handleLocalMall(options,p,cmd) {
    if(cmd==='mall_buy')return response(options,{items:buyLocalMall(p)});
    if(cmd==='mall_buyblackmarket')return response(options,{items:buyLocalMall(p,true)});
    if(cmd==='mall_refreshblackmarket'){prepareLocalMall(true);commitLocalMall();return response(options);}
    if(cmd==='role_useitem')return response(options,{items:useLocalBagItem(p)});
    return null;
  }

  const api = globalThis.localGame = {
    state,
    awakeningNodeUnlocked,
    isRepeatableMallGood,
    ghostPrice(times,group){return ghostDrawCost(Number(times),Number(group)).row;},
    ghostBatchCost(times,group,num=10){return ghostBatchCost(Number(times),Number(group),Number(num));},
    save: remember,
    platformMethods: {
      async init() { this.initResult = { rawInfo: { deviceInfo: {} } }; this.launchOptions = { query: {}, scene: 0 }; return true; },
      async login() { this.encryptUserInfo = { id: 'offline' }; return true; },
      async getLoginInfo() { return { uniqueId: 'offline', platformId: 'offline' }; },
      async getPlatformLoginInfo() { return { uniqueId: 'offline', platformId: 'offline' }; },
      async initSwitches(ids) { ids.forEach(id => this.switchResult.set(id, false)); return true; },
      checkSwitch() { return false; },
      onShare() {}, setVibrate() {}, setKeepScreenOn() {}, log() {}, business() {}, closeSplash() {},
      getNotice: async () => [], getQuestionnaireConfig: async () => [],
      getPlatformSetting: async () => ({}), checkUpdate: async () => false,
      pay: async () => { throw new Error('单机版没有充值功能'); },
      showModal(title, content, confirm, cancel, showCancel) {
        const modal = document.createElement('dialog');
        const text = document.createElement('p'); text.textContent = title + '：' + content; modal.append(text);
        const yes = document.createElement('button'); yes.textContent = '确定';
        yes.onclick = () => { modal.close(); modal.remove(); if (confirm) confirm(); }; modal.append(yes);
        if (showCancel) { const no = document.createElement('button'); no.textContent = '取消'; no.onclick = () => { modal.close(); modal.remove(); if (cancel) cancel(); }; modal.append(no); }
        document.body.append(modal); modal.showModal();
      },
      restartGame() { remember(); location.reload(); }, exitGame() { remember(); },
      getClipboard: async () => '', copyText: async text => navigator.clipboard.writeText(text)
    },
    async login(reconnect) {
      const [defs, server, configs, signals, platform, network, helper, ui] = await Promise.all([
        System.import('chunks:///_virtual/define-index.ts'), System.import('chunks:///_virtual/server-data.ts'),
        System.import('chunks:///_virtual/configs.ts'), System.import('chunks:///_virtual/global-signal.ts'),
        System.import('chunks:///_virtual/platform-manager.ts'), System.import('chunks:///_virtual/network-manager.ts'),
        System.import('chunks:///_virtual/role-helper.ts'), System.import('chunks:///_virtual/ui-signal.ts')
      ]);
      Object.assign(state, { defs, server, configs, roleHelper: helper.roleHelper, uiSignals:ui.UISignal });
      server.createServerData();
      let saved;
      try { saved = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { throw new Error('本地存档无法解析，请先导出备份再修复'); }
      if (!saved) saved = await fetch('/initial-role.json').then(r => { if (!r.ok) throw new Error('初始角色缺失'); return r.json(); });
      if (saved.format !== 1 || !saved.role || !Number.isFinite(saved.role.gold)) throw new Error('不支持的存档格式');
      state.evolutionApplied=validateEvolutionApplied(saved.evolutionApplied);
      hydrate(server.ROLE, saved.role);
      refreshLocalEvolutionStats();
      unlockLocalCosmetics();
      prepareLocalMall();
      server.ROLE.attrCard.shopLevel=2;
      if(!server.ROLE.hangUp.lastRewardTime)server.ROLE.hangUp.lastRewardTime=now()-configs.ConstantCfg.config.HangUpTimeMax*1000;
      server.ROLE.stage.battleId = 0;
      hydrate(server.USER, { id: 1, chooseRole: 1, loginPlatform: 'offline' });
      state.ready = true;
      platform.PlatformManager.ins.role = server.ROLE;
      const prototype = network.NetworkManager.prototype;
      prototype.isConnected = prototype.isAlive = () => true;
      prototype.connect = async () => true;
      signals.GlobalSignal.EventLogin.emit(Boolean(reconnect), server.ROLE);
      remember();
      LocalWX.status('本地存档已加载 · 单机测试版');
      console.info('[offline] 本地角色已加载', server.ROLE.level);
      return true;
    },
    async rpc(options) {
      if (!state.ready) return result({}, '本地角色尚未加载');
      const cmd = options.cmd.toLowerCase(), p = options.params || {}, role = state.server.ROLE;
      console.info('[offline RPC]', cmd);
      try {
        const mallReply=handleLocalMall(options,p,cmd);if(mallReply)return mallReply;
        if(['hero_fashiontakeon','hero_fashiononshow','hero_fashionsuitshow','hero_fashionlevelup','hero_fashionsuitlevelup'].includes(cmd)){changeLocalCosmetics(cmd,p);return response(options);}
        if(cmd==='role_drawattrcard')return response(options,{cardId:drawLocalGhostCard(p)});
        if(cmd==='role_chooseattrcard'){chooseLocalGhostCard(p.cardId);return response(options);}
        if(cmd==='role_updateattrcardshop'){role.attrCard.shopLevel=Math.min(2,role.attrCard.shopLevel+1);commitLocalCardFashion();return response(options);}
        if(cmd==='system_adcallback'&&[5,9,10].includes(Number(p.adId)))return response(options,{data:drawLocalGhostCard({cardType:1,cardGroup:Number(p.adId)===5?1:Number(p.adId)===9?2:3},true)});
        if(cmd==='role_gethangupreward')return response(options,{items:claimHangUp()});
        if(cmd==='role_sweephangup')return response(options,{items:sweepHangUp(p)});
        if(cmd==='role_attrlevelup'){upgradeHeroAttribute(p.growId);return response(options);}
        if(cmd==='mall_exchange')return response(options,{items:exchangeGoods(p)});
        if(cmd==='role_recruit')return response(options,recruit(p));
        if(cmd==='role_getrecruitreward') {
          const record=role.recruit.items.get(1),target=Number(p.id);
          if(!record||!Number.isSafeInteger(target))throw new Error('召唤记录不存在');
          const configs=state.configs.DrawWeekRewardCfg.list.filter(cfg=>cfg.Id>record.weekState&&cfg.Id<=target);
          if(!configs.length||!configs.some(cfg=>cfg.Id===target)||configs.some(cfg=>record.weekCount<cfg.DrawNum))throw new Error('没有可领取的召唤累计奖励');
          const items=configs.flatMap(cfg=>fixedRewards(cfg.RewardId));
          for(const item of items)addItem(item.id,item.count);
          record.weekState=target;commitEconomy();return response(options,{items:items.map(item=>rewardItem(item.id,item.count))});
        }
        if (cmd === 'battle_startbattle') return response(options, { battleData: buildBattle(p), attrRate: 1 });
        if (cmd === 'battle_endstagebattle') {
          state.lastBattleRequest={id:p.battleId,stageId:p.stageId,wave:p.wave,win:p.win,dropItems:Array.from(p.dropItems||[])};
          if (!state.activeBattle || p.battleId !== state.activeBattle.id) throw new Error('战斗记录不匹配，未发放奖励');
          const cfg = state.configs.StagePointCfg.getById(state.activeBattle.stageId);
          const stageWave = role.stage.levelStage.stageWave;
          let progress = stageWave.get(cfg.id);
          if (!progress) { progress = { pass: 0, reward: 0 }; stageWave.set(cfg.id, progress); }
          const validWave = cfg.phase.includes(p.wave) ? p.wave : (Number.isInteger(p.wave) && p.wave>0 && p.wave<=cfg.phase.length ? cfg.phase[p.wave-1] : 0);
          progress.pass = Math.max(progress.pass, validWave);
          role.stage.levelStage.waveId = Math.max(role.stage.levelStage.waveId, validWave);
          role.stage.levelStage.lastBattleId = cfg.id;
          if (p.win && validWave === cfg.phase[cfg.phase.length - 1]) {
            role.stage.levelStage.clearId = Math.max(role.stage.levelStage.clearId, cfg.id);
            role.stage.levelStage.passId = Math.max(role.stage.levelStage.passId, cfg.id);
          }
          const rewards = [];
          for (const [id, count] of p.dropItems || []) {
            const amount = Math.max(0, Math.floor(Number(count)));
            if (amount) {
              addItem(Number(id), amount);
              rewards.push(rewardItem(Number(id),amount));
            }
          }
          const earnedExp=state.activeBattle.staminaCost*state.configs.ConstantCfg.config.strengthExp;
          if(earnedExp>0)addItem(10001,earnedExp);
          role.stage.battleId = 0;
          role.stage.finishAt = now();
          state.activeBattle = null;
          commitEconomy();
          return response(options, { items: rewards, wave: validWave, resultType: p.win ? state.defs.EBattleResult.success : state.defs.EBattleResult.fail });
        }
        if (cmd === 'battle_monsterdead' || cmd === 'game_ping' || cmd === 'game_disconnect') return response(options);
        if(cmd==='battle_getstagewavereward') {
          const cfg=state.configs.StagePointCfg.getById(p.stageId), progress=role.stage.levelStage.stageWave.get(p.stageId);
          if(!cfg||!progress)throw new Error('没有可领取的关卡奖励');
          const items=[];let through=progress.reward;
          for(const wave of cfg.phase)if(wave>progress.reward&&wave<=progress.pass) {
            const phase=state.configs.StagePhaseCfg.getById(wave);
            if(phase.onceRewardId>0)items.push(...fixedRewards(phase.onceRewardId));
            through=wave;
          }
          for(const item of items)addItem(item.id,item.count);
          progress.reward=through;remember();
          return response(options,{items:items.map(item=>rewardItem(item.id,item.count))});
        }
        if (cmd === 'role_recoverenergy') {
          const config = state.configs.ConstantCfg.config;
          const interval = config.strengthRestoreTime * 1000;
          const steps = Math.max(0, Math.floor((now() - role.energy.lastRecoveryTime) / interval));
          if(role.energy.energyValue < config.strengthMax && steps > 0) {
            role.energy.energyValue = Math.min(config.strengthMax, role.energy.energyValue + steps);
            role.energy.lastRecoveryTime = now();
            remember();
          }
          return response(options);
        }
        if(cmd==='skill_skilllevelup') {upgradeSkill(Number(p.skillId));return response(options);}
        if(cmd==='skill_skillawakening') {awakenLocalBook(Number(p.id));return response(options);}
        if(cmd==='skill_skillequipplanset') {
          if(!(p.planMap instanceof Map)||p.planMap.size>8||new Set(p.planMap.values()).size!==p.planMap.size)throw new Error('无效或重复的符咒装备方案');
          for(const [slot,id] of p.planMap)if(!Number.isInteger(slot)||slot<1||slot>8||!role.skill.epicSkillLevel.get(id))throw new Error('方案包含未解锁的符咒');
          const plan=hydrate(new state.defs.GDEquipSkillPlan(),{name:String(p.name||'').slice(0,20)});
          plan.skill=new Map(p.planMap);role.skill.equipSkillPlan.set(p.planId,plan);
          if(p.planId===role.skill.equipPlanId)role.skill.equipSkill=new Map(p.planMap);
          remember();return response(options);
        }
        if(cmd==='skill_skillequipplanchange') {
          const plan=role.skill.equipSkillPlan.get(p.planId);if(!plan)throw new Error('方案不存在');
          role.skill.equipPlanId=p.planId;role.skill.equipSkill=new Map(plan.skill);remember();return response(options);
        }
        if(cmd==='skill_skillactive') {
          const base=state.configs.SkillBookCfg.getById(p.skillId),active=state.configs.SkillBookCfg.getById(p.activeId),style=state.configs.SkillStyleCfg.getById(p.skillId);
          if(!base||!active||!style||base.elementalType!==active.elementalType||base.quality!==active.quality)throw new Error('符咒变化配置不匹配');
          const index=style.unlockSkill.indexOf(p.activeId), level=role.skill.cardSkillLevel.get(base.elementalType)?.get(base.quality)||0;
          if(p.activeId!==p.skillId&&(index<0||level<style.unlockLevel[index]))throw new Error('此符咒变化尚未解锁');
          role.skill.activeSkill.set(p.skillId,p.activeId);remember();return response(options);
        }
        if (cmd === 'game_getserverinfo') {
          const data = response(options);
          Object.assign(data.rawData.serverInfo, { id: 1, groupId: 1, name: '本地单机', openTime: role.createAt });
          if (data.rawData.mainServerInfo) Object.assign(data.rawData.mainServerInfo, data.rawData.serverInfo);
          return data;
        }
        if (cmd === 'game_changerolename') {
          const name = String(p.name || '').trim();
          if (!name || name.length > 20) throw new Error('名字需要 1 至 20 个字符');
          role.userInfo.name = name; remember(); return response(options);
        }
        if (cmd === 'role_updateguide') { role.guide = Number(p.guideId ?? p.id ?? p.guide ?? role.guide); remember(); return response(options); }
        if (cmd === 'game_crossday' || cmd === 'system_updaterolestatistics') { remember(); return response(options); }
        if (cmd === 'system_getsystemconfig') return response(options, { offSet: 0 });
        if (cmd === 'game_rolelogin') return response(options, { isNew: false });
        // 读取服务返回协议定义的空集合；未实现的写操作明确报错。
        if (/_(get|list|chatget)/.test(cmd) || ['game_enterworld','game_rolelist'].includes(cmd)) return response(options);
        return result({}, '此功能尚未完成单机适配：' + cmd);
      } catch (error) { console.error('[offline RPC]', cmd, error); return result({}, error.message); }
    },
    exportSave() {
      remember();
      const blob = new Blob([localStorage.getItem(SAVE_KEY) || '{}'], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = '遗弃之地-单机存档.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    },
    importSave(text) {
      if(!state.ready)throw new Error('请等待角色加载');
      const data=JSON.parse(text);
      if(data.format!==1||!data.role)throw new Error('存档格式不支持');
      validateEvolutionApplied(data.evolutionApplied);
      for(const key of ['gold','diamond','level'])if(!Number.isSafeInteger(data.role[key])||data.role[key]<0)throw new Error('存档数值无效');
      const trial=hydrate(new state.defs.GDRole(),data.role);
      if(!trial.hero?.attribute?.attributes?.get||!trial.skill?.cardSkillLevel?.get)throw new Error('存档角色结构无效');
      data.role.id=data.role.uId=data.role.sId=1;data.role.uKey='offline-1';
      remember();localStorage.setItem(SAVE_KEY+'.previous',localStorage.getItem(SAVE_KEY));
      localStorage.setItem(SAVE_KEY,JSON.stringify(data));state.ready=false;location.reload();
    },
    editCurrencies(gold, diamond) {
      if (!state.ready) throw new Error('请先等待角色加载');
      for (const number of [gold, diamond]) if (!Number.isSafeInteger(number) || number < 0) throw new Error('请输入非负安全整数');
      // 通过角色增量更新触发货币同步信号，让游戏顶部数值立即刷新。
      state.server.ROLE.setValue({ gold, diamond, freeDiamond: diamond });
      remember();
    },
    editEnergy(energy) {
      if (!state.ready) throw new Error('请先等待角色加载');
      if (!Number.isSafeInteger(energy) || energy < 0) throw new Error('体力请输入非负安全整数');
      // 本地修改不受自然恢复上限限制，并重置恢复计时。
      state.server.ROLE.setValue({ energy: { energyValue: energy, lastRecoveryTime: now() } });
      remember();
    },
    editHero(attack, hp) {
      if (!state.ready) throw new Error('请先等待角色加载');
      for (const value of [attack,hp]) if(!Number.isSafeInteger(value)||value<1||value>1000000000) throw new Error('攻击和生命请输入 1 至 10 亿的整数');
      const keys=state.configs.BattleAttributeKey, attrs=state.server.ROLE.hero.attribute.attributes;
      attrs.set(keys.ATK_ABS,Math.ceil(attack/(1+(attrs.get(keys.ATK_PCT)||0)/10000)));
      attrs.set(keys.HP_ABS,Math.ceil(hp/(1+(attrs.get(keys.HP_PCT)||0)/10000)));
      attrs.set(keys.ATK_V,attack);attrs.set(keys.HP_V,hp);remember();
    }
  };
  LocalWX.afterEnv = current => Object.assign(current, { APP_CDN: LocalWX.localURL('/cdn'), APP_CDNS: [LocalWX.localURL('/cdn')] });
  const panel = document.createElement('details');
  panel.id = 'local-tools';
  panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:100000;background:#18241eeb;padding:8px;border:1px solid #809180;border-radius:6px;color:white;font:14px system-ui;max-width:300px';
  panel.innerHTML = '<summary>本地存档工具</summary><p style="max-width:260px">测试版：主线适配中，未完成的功能会提示。存档仅保存在此浏览器。攻击与生命在下场战斗生效。</p><label>铜钱 <input id="local-gold" type="number" min="0" step="1" style="width:150px"></label><br><label>元宝 <input id="local-diamond" type="number" min="0" step="1" style="width:150px"></label><br><label>体力 <input id="local-energy" type="number" min="0" step="1" style="width:150px"></label><br><label>攻击 <input id="local-atk" type="number" min="1" step="1" style="width:150px"></label><br><label>生命 <input id="local-hp" type="number" min="1" step="1" style="width:150px"></label><p><button id="local-edit">保存数值</button> <button id="local-export">导出存档</button></p><div id="local-tool-result" role="status"></div>';
  document.body.append(panel);
  panel.addEventListener('toggle', () => { if(panel.open && state.ready){const r=state.server.ROLE,keys=state.configs.BattleAttributeKey;document.getElementById('local-gold').value=r.gold;document.getElementById('local-diamond').value=r.diamond;document.getElementById('local-energy').value=r.energy.energyValue;document.getElementById('local-atk').value=r.hero.attribute.attributes.get(keys.ATK_V);document.getElementById('local-hp').value=r.hero.attribute.attributes.get(keys.HP_V);} });
  document.getElementById('local-edit').onclick = () => {
    const notice = document.getElementById('local-tool-result');
    try {const values=['gold','diamond','atk','hp','energy'].map(id=>Number(document.getElementById('local-'+id).value));if(values.some(v=>!Number.isSafeInteger(v))||values[0]<0||values[1]<0||values[2]<1||values[3]<1||values[2]>1000000000||values[3]>1000000000||values[4]<0)throw new Error('请输入有效非负整数；攻击、生命范围 1 至 10 亿');api.editCurrencies(values[0],values[1]);api.editHero(values[2],values[3]);api.editEnergy(values[4]);notice.textContent='已保存到本地';}
    catch(error){notice.textContent=error.message;}
  };
  document.getElementById('local-export').onclick = api.exportSave;
  const importLabel=document.createElement('label');importLabel.textContent='导入存档 ';
  const importInput=document.createElement('input');importInput.type='file';importInput.accept='.json,application/json';importInput.style.width='200px';
  importInput.onchange=async()=>{try{const file=importInput.files[0];if(!file)return;if(file.size>5000000)throw new Error('存档文件过大');api.importSave(await file.text());}catch(error){document.getElementById('local-tool-result').textContent=error.message;}finally{importInput.value='';}};
  importLabel.append(importInput);panel.append(importLabel);
  window.addEventListener('pagehide', remember);
  setInterval(remember, 15000);
}());
