/* 单机开放：取消成长入口、购买次数与解封等待，结算写入原角色存档。 */
(function(){
  'use strict';
  let state,tools,c,d,r,ui;
  const own=(map,key,create)=>{if(!map.has(key))map.set(key,create());return map.get(key);};
  const integer=(value,fallback=1,max=9999)=>{const n=Number(value??fallback);if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('操作数量无效');return n;};
  const choose=items=>items[Math.floor(Math.random()*items.length)];
  const weighted=(items,weights)=>{let p=Math.random()*weights.reduce((a,b)=>a+b,0);for(let i=0;i<items.length;i++){p-=weights[i];if(p<0)return items[i];}return items[items.length-1];};
  function emit(...names){for(const name of names)ui[name]?.dispatch?.();}
  function commit(){
    const snap=tools.plain(r);
    r.setValue(Object.fromEntries(['hero','fightPower','fightPowerMax','pet','desire','roleBase','magic','equipment','achievement','bag','shop','skill','unlockModuleIds'].map(key=>[key,snap[key]])));
    tools.remember();
  }
  function sum(map,source,multiplier=1){source?.forEach((value,key)=>map.set(Number(key),(map.get(Number(key))||0)+value*multiplier));}
  // 用模块差额更新属性；重开游戏不会把已保存的成长属性重复叠加。
  function moduleAttributes(type,next){
    const group=own(r.hero.attribute.moduleAttr,type,()=>new d.GDModuleAttribute());
    const old=group.attrData.get(group.curUse)||new Map(),attrs=r.hero.attribute.attributes;
    let changed=false,power=0;
    for(const key of new Set([...old.keys(),...next.keys()])){
      const delta=(next.get(Number(key))||0)-(old.get(key)||0);if(!delta)continue;
      changed=true;attrs.set(Number(key),(attrs.get(Number(key))||0)+delta);power+=delta*(c.AttrCfg.getById(Number(key))?.power||0);
    }
    group.attrData.set(group.curUse,new Map(next));
    if(changed){const k=c.BattleAttributeKey;attrs.set(k.ATK_V,Math.floor((attrs.get(k.ATK_ABS)||0)*(1+(attrs.get(k.ATK_PCT)||0)/10000)));attrs.set(k.HP_V,Math.floor((attrs.get(k.HP_ABS)||0)*(1+(attrs.get(k.HP_PCT)||0)/10000)));r.fightPower=Math.max(0,r.fightPower+Math.round(power));r.hero.fightPower=Math.max(0,r.hero.fightPower+Math.round(power));r.fightPowerMax=Math.max(r.fightPowerMax,r.fightPower);}
  }
  function stats(){
    const pills=new Map();r.hero.pillEatNum.forEach((num,id)=>sum(pills,c.PillConfig.getById(id)?.attr,num));moduleAttributes(d.ModuleAttrType.pill,pills);
    const base=new Map(),cfg=c.BaseCfg.getById(r.roleBase.level);for(const attr of cfg?.attr||[])sum(base,attr);
    r.roleBase.skinLevel.forEach((level,id)=>sum(base,c.BaseSkinCfg.getById(id)?.attrs?.[level-1]));
    for(const cfg of c.SkinCollectionCfg.list)if(cfg.unlockLevel<=r.roleBase.collect)for(const attr of cfg.attrs||[])sum(base,attr);
    moduleAttributes(d.ModuleAttrType.roleBase,base);
    const desire=new Map();r.desire.plan.get(r.desire.planOnUsed)?.forEach(id=>sum(desire,c.DesireCfg.getById(r.desire.bag.get(id)?.cfgId)?.attr));moduleAttributes(d.ModuleAttrType.desire,desire);
    const equip=new Map();r.equipment.plan.get(r.equipment.usePlan)?.slot?.forEach(id=>{const item=r.equipment.bag.get(id),cfg=c.EquipmentCfg.getById(item?.configId);if(cfg)sum(equip,cfg.LevelGrowthAttr[Math.min(r.equipment.level.get(cfg.equipmentType)||0,cfg.LevelGrowthAttr.length-1)]);});moduleAttributes(d.ModuleAttrType.equipment,equip);
    const magic=new Map();r.magic.magicWeapon.forEach(item=>sum(magic,c.MagicArtifactBaseCfg.getById(item.cfgId)?.attrs[item.level-1]));
    r.magic.plan.get(r.magic.onUsePlan)?.entry?.forEach(entry=>{const cfg=c.MagicArtifactEntryCfg.getById(entry.cfgId);if(cfg)magic.set(cfg.attrType,(magic.get(cfg.attrType)||0)+entry.value);});
    for(const cfg of c.MagicArtifactCollectionCfg.list)if(cfg.id<=r.magic.collectionLevel)for(const attr of cfg.attrs||[])sum(magic,attr);
    moduleAttributes(d.ModuleAttrType.magic,magic);
    const petAttrs=new Map(),pet=r.pet.bag.get(r.pet.fightId);if(pet){sum(petAttrs,c.PetQualityCfg.getById(pet.quality)?.attr);for(const id of [1,2,...pet.entry]){const cfg=c.PetLevelAttrCfg.getById(id);if(cfg)petAttrs.set(cfg.attrType,(petAttrs.get(cfg.attrType)||0)+cfg.stat*pet.level);}for(const [id,level]of pet.passiveSkill){const cfg=c.PetSkillCfg.getById(id);cfg?.attrType.forEach((key,i)=>petAttrs.set(key,(petAttrs.get(key)||0)+(cfg.stat[i]||0)*level));}}
    moduleAttributes(d.ModuleAttrType.pet,petAttrs);
  }
  function createPet(cfgId){
    const cfg=c.PetCfg.getById(Number(cfgId));if(!cfg)throw new Error('鬼仆配置不存在');
    const pet=new d.GDPetItem();Object.assign(pet,{id:++r.pet.bagId,cfgId:cfg.id,quality:cfg.quality,level:1});
    for(const skill of cfg.commonSkill)pet.skillLevel.set(skill,1);
    const passives=c.PetSkillCfg.list.filter(x=>x.quality<=pet.quality).slice(0,c.PetQualityCfg.getById(pet.quality)?.skillNum||1);
    const quality=c.PetQualityCfg.getById(pet.quality),entries=c.PetEntryGroupCfg.getById(quality?.entryGroup);pet.entry=entries?.entryId.slice(0,quality.entryNum[0]||1)||[];pet.initEntry=[...pet.entry];
    pet.passiveSkill=passives.map(x=>[x.id,1]);r.pet.bag.set(pet.id,pet);r.pet.petCollect.set(cfg.id,Math.max(r.pet.petCollect.get(cfg.id)||0,pet.quality));return pet;
  }
  function petReward(pet){const reward=new d.RewardItem();reward.rewardType=d.ERewardItemType.pet;reward.data=pet;return reward;}
  function addDesire(id,num){
    const cfg=c.DesireCfg.getById(id);if(!cfg)throw new Error('三尸物品不存在');
    let item=[...r.desire.bag.values()].find(x=>x.cfgId===id&&!x.locked);
    if(!item){item=new d.GDDesireItem();Object.assign(item,{id:++r.desire.bagId,cfgId:id});r.desire.bag.set(item.id,item);}
    item.num+=num;r.desire.itemLog.set(id,(r.desire.itemLog.get(id)||0)+num);return item;
  }
  function petFromBox(pos){
    const extra=r.pet.petBoxExtra.get(pos),box=r.pet.petBox.get(pos),fromExtra=Boolean(extra?.length),id=fromExtra?extra.shift():box?.id;
    if(!id)throw new Error('该解封栏没有阴契');if(!extra?.length)r.pet.petBoxExtra.delete(pos);
    if(!fromExtra)r.pet.petBox.delete(pos);
    const cfg=c.PetIncubateCfg.getById(id);if(!cfg)throw new Error('阴契配置缺失');return createPet(weighted(cfg.petId,cfg.weight));
  }
  function prepareHatching(){
    for(const box of r.pet.petBox.values())box.createTime=1;
    while(r.pet.bornList.length){let pos=1;while(pos<=4&&(r.pet.petBoxExtra.get(pos)?.length||0)>=9)pos++;if(pos>4)break;const item=c.ItemCfg.getById(r.pet.bornList.shift());const id=item?.param?.[0];if(id)own(r.pet.petBoxExtra,pos,()=>[]).push(id);}
  }
  function grantItem(id,num){
    if(!c)return false;const cfg=c.ItemCfg.getById(id);if(!cfg)return false;
    if(cfg.type===c.ItemType.DESIRE){addDesire(id,num);return true;}
    if(cfg.type===c.ItemType.EQUIPMENT&&c.EquipmentCfg.getById(cfg.param[0])){for(let i=0;i<num;i++)createEquipment(cfg.param[0]);return true;}
    if(cfg.type===c.ItemType.MAGICARTIFACT){const key=cfg.param[0],weapon=own(r.magic.magicWeapon,key,()=>new d.GDMagicWeapon());weapon.cfgId=key;weapon.level=Math.min(c.MagicArtifactBaseCfg.getById(key).cost.length,weapon.level+num);return true;}
    if(cfg.type===c.ItemType.MAGICARTIFACTSTONE){const key=cfg.param[0],stone=own(r.magic.gemstone,key,()=>new d.GDGemstone());stone.cfgId=key;stone.level=Math.min(c.MagicArtifactStoneCfg.getById(key).cost.length,stone.level+num);return true;}
    if(cfg.type===c.ItemType.PET){const fixed=c.PetFixedCfg.getById(cfg.param[0]);if(!fixed)throw new Error('鬼仆契约配置不存在');for(let i=0;i<num;i++){const pet=createPet(fixed.petId);pet.quality=Math.max(pet.quality,5);pet.passiveSkill=fixed.skillId.map(id=>[id,1]);pet.entry=[...fixed.entryId];pet.initEntry=[...pet.entry];}return true;}
    if(cfg.type===c.ItemType.PET_SKIN){const skin=c.PetSkinCfg.getById(cfg.param[0]);if(skin){r.pet.petSkin.set(skin.id,Math.min(skin.level,(r.pet.petSkin.get(skin.id)||0)+num));r.pet.skinCollect.set(skin.id,1);}return true;}
    return false;
  }
  function activatePurchase(cfg){
    // 本地购买不调用支付；特权记录与原界面使用同一份数据。
    const type=Number(cfg.rechargeType);if(type>0){
      const card=own(r.shop.chargeCard,type,()=>new d.GDChargeCard());card.expireTime=Date.now()+100*365*86400000;card.lastReceiveTime=0;
    }
    if(cfg.id===105)r.pet.buyBoxNum=Math.max(1,r.pet.buyBoxNum);
    emit('GetOrderReward');
  }
  const freeArray=(array)=>Array.isArray(array)?array.map(x=>typeof x==='number'?0:Array.isArray(x)?freeArray(x):x&&typeof x==='object'&&'num'in x?Object.assign(x,{num:0}):x):array;
  async function prepare(next,helpers){
    state=next;tools=helpers;c=state.configs;d=state.defs;r=state.server.ROLE;ui=state.uiSignals;
    r.unlockModuleIds=c.UnlockCfg.list.map(x=>x.id);
    for(const cfg of c.UnlockCfg.list){cfg.condition.clear();cfg.showCondition.clear();cfg.close=0;cfg.punishClose=0;}
    const helper=state.roleHelper;
    helper.getModulesUnlock=helper.getModulesShow=helper.getRoleModuleUnlocked=()=>true;
    helper.checkCondition=()=>true;helper.wouldExceedItemDailyObtainMax=()=>false;helper.getRvLessTimes=()=>999999;helper.getServerOpenDay=()=>99999;
    // 新开放入口不再触发强制教学遮罩，避免按钮被引导层挡住。
    const {GuideManager}=await System.import('chunks:///_virtual/guide-manager.ts');GuideManager.prototype.startGuide=function(){};r.guide=999999;
    for(const cfg of c.SkillStyleCfg.list)cfg.unlockLevel=cfg.unlockLevel.map(()=>0);
    for(const cfg of c.SkillBookCfg.list)if(cfg.type===c.SkillBookType.SPECIALCARD&&!r.skill.epicSkillLevel.get(cfg.id))r.skill.epicSkillLevel.set(cfg.id,1);
    for(const cfg of c.MallConfig.list){cfg.conditions.clear();cfg.douconditions?.clear();cfg.limit=0;cfg.consume=[];}
    for(const cfg of c.ItemPurchaseCfg.list){cfg.dailyLimit=-1;cfg.price=freeArray(Array.isArray(cfg.price)?cfg.price:[cfg.price]);}
    for(const name of ['PetIncubateCfg'])for(const cfg of c[name].list)cfg.time=0;
    c.ConstantCfg.config.PetUnlockTime=0;c.ConstantCfg.config.PetIncubateSlotInit=4;c.ConstantCfg.config.PetIncubateSlotPrice=0;c.ConstantCfg.config.PetBornNowCost=0;
    c.ConstantCfg.config.HangUpRewardPeriod=0;c.ConstantCfg.config.localOriginalSweepCost??=[...c.ConstantCfg.config.HangUpSweepCost];c.ConstantCfg.config.HangUpSweepCost=c.ConstantCfg.config.HangUpSweepCost.map(()=>0);
    c.ConstantCfg.config.DesirePlanChangeNameCd=0;c.ConstantCfg.config.PetSkillLevelUpCost=freeArray(c.ConstantCfg.config.PetSkillLevelUpCost);
    for(const cfg of c.StagePointCfg.list){cfg.localOriginalStamina??=cfg.stamina;cfg.stamina=0;}
    // 保留配置中的最高阶，移除材料、角色等级、日期及每日产出限制。
    for(const name of ['SkillBookCfg','PetLevelUpCfg','PetSymbiosisCfg','BaseCfg','BaseSkinCfg','PetSkinCfg','PetEmbattleCfg','MagicArtifactBaseCfg','MagicArtifactStoneCfg','PillFurnaceConfig','EquipmentCfg','AttrGrowCfg','RecycleCfg'])for(const cfg of c[name]?.list||[]){
      for(const key of ['cost','goldCost','LockConsume','formula','smeltCost']){if(name==='RecycleCfg'&&key==='formula')continue;if(Array.isArray(cfg[key]))cfg[key]=freeArray(cfg[key]);else if(typeof cfg[key]==='number')cfg[key]=0;}
      if('costCoin'in cfg)cfg.costCoin=0;if('costItem'in cfg)cfg.costItem=freeArray(cfg.costItem);if(name==='RecycleCfg'){cfg.condition.clear();cfg.limit=0;}
    }
    for(const cfg of c.LevelCfg.list){for(const [type]of cfg.attrLimit)cfg.attrLimit.set(type,Math.max(...c.AttrGrowCfg.list.filter(x=>String(x.attrType)===type).map(x=>x.level),0));}
    const [shop,pill,pet,desire,base,gacha,pillUI,petLevel]=await Promise.all(['shop-helper.ts','pill-module.ts','pet-helper.ts','desire-module.ts','base-land-helper.ts','ui-desire-gacha-page.ts','ui-pill.ts','pet-level-up.ts'].map(n=>System.import('chunks:///_virtual/'+n)));
    shop.shopHelper.getMallBuyTimes=()=>0;shop.shopHelper.getShopCanBuy=()=>true;shop.shopHelper.checkMallCfgDown=()=>false;
    shop.shopHelper.getCurLifeCardType=shop.shopHelper.getCurMouthCardType=()=>1;
    const pp=pill.PillModule.prototype;pp.isUnlock=()=>true;pp.checkPillFurnaceUnlocked=()=>true;pp.getPillMaxNum=()=>Number.MAX_SAFE_INTEGER;pp.getPillNextUnlockLv=()=>-1;pp.isPillFurnaceCanMake=()=>true;pp.getCurrentCanMakeMaxCnt=()=>9999;
    pp.getAllUnlockedInnerPill=()=>c.PillConfig.list.filter(x=>x.type===1);
    Object.defineProperty(pp,'PillLevel',{configurable:true,get:()=>Math.max(...c.PillLlandudnoCfg.list.map(x=>x.id))});
    pp.goto=async which=>{const {OPEN_UI}=await System.import('chunks:///_virtual/ui-manager.ts'),{CommonUICfgId}=await System.import('chunks:///_virtual/ui-common-cfg.ts');return OPEN_UI(CommonUICfgId.PillUI,which==='PillUI1'?3:0);};
    const ph=pet.petHelper;ph.getPetCardType=()=>1;ph.isPetHatchSlotRowUnlocked=()=>true;ph.getUnlockedPetHatchSlotCount=()=>4;ph.getFirstLockedPetHatchSlot=()=>0;ph.checkPetShopSecPage=()=>true;ph.chechSymbiosisUnLock=()=>true;
    ph.getFreePetHatchSlot=()=>[1,2,3,4].sort((a,b)=>(r.pet.petBoxExtra.get(a)?.length||0)-(r.pet.petBoxExtra.get(b)?.length||0))[0];ph.checkPetHatchFull=ph.checkPetHatchQueueFull=()=>false;
    ph.isFormationLianxieUnlockedAtLevel=ph.isFormationLianxieSlotUnlocked=()=>true;ph.getFormationLianxieUnlockLevel=ph.getFormationLianxieSlotUnlockLevel=()=>0;
    ph.getFormationSlotStatus=(id,slot)=>{const petId=slot===0?r.pet.fightId:r.pet.formation.plan.get(id)?.get(slot);return petId?pet.PetFormationSlotStatus.OCCUPIED:pet.PetFormationSlotStatus.EMPTY;};
    ph.getPetLevelLimit=()=>Math.max(...c.PetLevelUpCfg.list.map(x=>x.id));ph.getPetCanUpLevel=id=>{const p=r.pet.bag.get(id);return!!p&&p.level<ph.getPetLevelLimit(id);};
    petLevel.PetLevelUp.prototype._checkUpgradeResources=()=>true;petLevel.PetLevelUp.prototype.checkMaterialEnough=()=>true;
    desire.DesireModule.prototype.canDoGacha=()=>true;
    const gp=gacha.UIDesireGachaPage.prototype;gp.onGacha1Click=function(){this.module.cardGameStart(1).then(ok=>{if(ok)this.afterCardGameStart();});};gp.onGacha10Click=function(){this.module.cardGameStart(5).then(ok=>{if(ok)this.afterCardGameStart();});};
    const pu=pillUI.UIPill.prototype,updatePill=pu.updatePillModeDisplay;pu.updatePillModeDisplay=function(...args){const out=updatePill.apply(this,args);this.isEnoughMaterial=true;return out;};pu.checkRecycleDailyOutputLimit=()=>true;
    pu.getRecycleExistTime=()=>null;const make=pu.onPillMakeClick;pu.onPillMakeClick=function(){if(this.isRecycleMode)return this.module.pillRecycle(this.currentRecycleCfgId,new Map(),Math.max(1,this.currentRecycleCnt||1));return make.call(this);};
    base.baseLandHelper.isBaseLandLevelUpCostEnough=()=>true;base.baseLandHelper.meetsBaseLevelForSkillEntry=()=>true;base.baseLandHelper.isBaseSkillBookUnlocked=()=>true;
    for(const cfg of c.PetCfg.list)if(![...r.pet.bag.values()].some(x=>x.cfgId===cfg.id))createPet(cfg.id);
    for(const cfg of c.PetSkinCfg.list)if(!r.pet.petSkin.get(cfg.id)){r.pet.petSkin.set(cfg.id,1);r.pet.skinCollect.set(cfg.id,1);}
    r.pet.buyBoxNum=Math.max(1,r.pet.buyBoxNum);prepareHatching();
    r.pet.symbiosis.lv=Math.max(1,r.pet.symbiosis.lv);
    for(const cfg of c.PetEmbattleCfg.list){if(!r.pet.formation.level.get(cfg.id))r.pet.formation.level.set(cfg.id,1);own(r.pet.formation.plan,cfg.id,()=>new Map());}
    if(!r.pet.formation.planOnUsed)r.pet.formation.planOnUsed=c.PetEmbattleCfg.list[0]?.id||0;
    for(const cfg of c.DesireCfg.list)if(![...r.desire.bag.values()].some(x=>x.cfgId===cfg.id))addDesire(cfg.id,1);
    for(let i=0;i<3;i++)own(r.desire.plan,i,()=>new Map());
    for(const cfg of c.BaseSkinCfg.list)if(!r.roleBase.skinLevel.get(cfg.id))r.roleBase.skinLevel.set(cfg.id,1);
    if(!r.roleBase.skin)r.roleBase.skin=1;
    for(const cfg of c.BaseCfg.list)if(cfg.unlockSkillBookId&&!r.roleBase.skill.get(cfg.unlockSkillBookId))r.roleBase.skill.set(cfg.unlockSkillBookId,1);
    const [magic,equipment,task,handbook]=await Promise.all(['magic-artifact-module.ts','equipment-helper.ts','task-helper.ts','handbook-helper.ts'].map(n=>System.import('chunks:///_virtual/'+n)));
    const mp=magic.MagicArtifactModule.prototype;mp.isArtifactOpen=()=>true;mp.canActivateOrUpgradeArtifact=function(id){return !this.isArtifactMaxLevel(id);};mp.canUpgradeStone=function(id){return this.getStoneProgress(id).level<this.getStoneMaxLevel(id);};mp.canAffordTemper=()=>true;mp.getTemperUnlockedSlotCount=function(){return this.getMaxTemperEntrySlotCount();};mp.getTemperUnlockedPlanCount=function(){return this.getMaxTemperPlanCount();};mp.isTemperPlanUnlocked=()=>true;mp.canActivateCollectionLevel=function(){return !this.isCollectionMaxLevel();};
    const eh=equipment.equipmentHelper||equipment.EquipmentHelper;eh.isEquipmentSlotUnlock=()=>true;
    eh.getEquipmentBaseAttr=(cfg,level)=>cfg.LevelGrowthAttr[Math.max(0,Math.min(level,cfg.LevelGrowthAttr.length-1))];
    task.taskHelper.getTaskState=id=>c.TaskCfg.getById(id)?d.ETaskState.finish:d.ETaskState.unFinish;
    if(handbook.handBookHelper)handbook.handBookHelper.getStateByID=()=>handbook.HandBookStatus.CanClaim;
    const evolution=await System.import('chunks:///_virtual/special-evolution-module.ts');
    if(evolution.SpecialEvolutionModule)evolution.SpecialEvolutionModule.prototype.canSpecialSkillEvolution=id=>Boolean(c.SkillBookEvolutionCfg.list.some(x=>x.skillBookBelong===id));
    const {PetQualityUp}=await System.import('chunks:///_virtual/pet-quality-up.ts');
    PetQualityUp.prototype.onClickQualityUp=async function(){if(this.localFreeBusy||!r.pet.bag.has(this.curSelectPetId))return;this.localFreeBusy=true;try{const result=await d.PetService.petMerge({petId:this.curSelectPetId,mergeId:[],itemId:[]});if(!result.error&&this.isValid){this.refreshCurPet();this.refreshList();emit('PetQualityUpSuccess','popFightPowerUp');}}finally{this.localFreeBusy=false;}};
    PetQualityUp.prototype.onClickAutoQualityUp=PetQualityUp.prototype.onClickQualityUp;
    for(const cfg of c.MagicArtifactBaseCfg.list){cfg.open=1;const weapon=own(r.magic.magicWeapon,cfg.id,()=>new d.GDMagicWeapon());weapon.cfgId=cfg.id;weapon.level=Math.max(1,weapon.level);}
    for(const cfg of c.MagicArtifactStoneCfg.list){const stone=own(r.magic.gemstone,cfg.id,()=>new d.GDGemstone());stone.cfgId=cfg.id;stone.level=Math.max(1,stone.level);}
    r.magic.refineLevel=Math.max(1,r.magic.refineLevel);if(!r.magic.onUsePlan)r.magic.onUsePlan=1;
    for(let plan=1;plan<=6;plan++)own(r.magic.plan,plan,()=>new d.GDMagicPlan());
    for(const cfg of c.EquipmentCfg.list)if(![...r.equipment.bag.values()].some(x=>x.configId===cfg.id))createEquipment(cfg.id);
    for(const cfg of c.MallConfig.list)activatePurchase(cfg);
    for(const cfg of c.ItemCfg.list)if(cfg.type===c.ItemType.PET_ITEM&&(r.bag.get(cfg.id)?.n||0)<1)tools.addItem(cfg.id,1);
    for(const cfg of c.AchieveTaskCfg.list)if(r.achievement.tasks.get(cfg.id)!==d.ETaskState.recAward)r.achievement.tasks.set(cfg.id,d.ETaskState.finish);
    stats();
  }
  function petAction(cmd,p){
    const pet=r.pet.bag.get(Number(p.petId)),items=[];
    if(cmd==='pet_chooseinitpet'){const init=[...r.pet.bag.values()].find(x=>x.cfgId===Number(p.petId))||createPet(p.petId);r.pet.initPet=init.cfgId;r.pet.fightId=init.id;items.push(petReward(init));}
    else if(cmd==='pet_petfight'){if(!pet)throw new Error('鬼仆不存在');r.pet.fightId=pet.id;}
    else if(cmd==='pet_buypetbox')r.pet.buyBoxNum++;
    else if(cmd==='pet_bornpet'){
      const item=c.ItemCfg.getById(Number(p.itemId)),cfg=c.PetIncubateCfg.getById(item?.param?.[0]);if(!cfg)throw new Error('请选择阴契');
      let pos=Number(p.pos)||1;if(pos<1||pos>4)throw new Error('解封栏无效');own(r.pet.petBoxExtra,pos,()=>[]).push(cfg.id);
    }
    else if(cmd==='pet_getbornpet')items.push(petReward(petFromBox(Number(p.pos))));
    else if(cmd==='pet_getbornpetall'){const quality=new Map();for(let pos=1;pos<=4;pos++){while(r.pet.petBox.has(pos)||r.pet.petBoxExtra.get(pos)?.length){const next=petFromBox(pos);items.push(petReward(next));quality.set(pos,Math.max(quality.get(pos)||0,next.quality));}}commit();return{items,quality};}
    else if(cmd==='pet_refreshbornlist')prepareHatching();
    else if(cmd==='pet_removebornlistitem')r.pet.bornList.splice(Number(p.pos),1);
    else if(cmd==='pet_petlevelup'){if(!pet)throw new Error('鬼仆不存在');pet.level=Math.min(Math.max(...c.PetLevelUpCfg.list.map(x=>x.id)),pet.level+integer(p.addLevel));}
    else if(cmd==='pet_petskilllevelup'){if(!pet)throw new Error('鬼仆不存在');const id=Number(p.skillId),cfg=c.SkillBookCfg.getById(id)||c.PetSkillCfg.getById(id);if(!cfg)throw new Error('技能不存在');pet.skillLevel.set(id,Math.min(cfg.levelMax,(pet.skillLevel.get(id)||1)+integer(p.addLevel)));}
    else if(cmd==='pet_petlock'){if(!pet)throw new Error('鬼仆不存在');pet.lock=Number(p.lock??p.locked??1);}
    else if(cmd==='pet_upgradeskin'){const id=Number(p.skinId??p.id),cfg=c.PetSkinCfg.getById(id);if(!cfg)throw new Error('鬼仆皮肤不存在');r.pet.petSkin.set(id,Math.min(cfg.level,(r.pet.petSkin.get(id)||0)+1));}
    else if(cmd==='pet_useskin'){if(!pet)throw new Error('鬼仆不存在');pet.skin=Number(p.skinId??p.skin??0);}
    else if(cmd==='pet_updateformation'){const id=Number(p.id),cfg=c.PetEmbattleCfg.getById(id);if(!cfg)throw new Error('阵法不存在');r.pet.formation.level.set(id,Math.min(cfg.cost.length,(r.pet.formation.level.get(id)||0)+1));}
    else if(cmd==='pet_linkedskillfight'){own(r.pet.formation.linkedSkill,r.pet.formation.planOnUsed,()=>new Map()).set(Number(p.idx),Number(p.petId));}
    else if(cmd==='pet_updatesymformation')r.pet.symbiosis.lv=Math.min(c.PetSymbiosisCfg.list.length,r.pet.symbiosis.lv+1);
    else if(cmd==='pet_changesymformation'){const formation=own(r.pet.symbiosis.formation,Number(p.id),()=>new d.GDPetSymFormation());formation.pets=new Map(p.pets);}
    else if(cmd==='pet_switchformation'){const id=Number(p.id);if(!c.PetEmbattleCfg.getById(id))throw new Error('阵法不存在');r.pet.formation.planOnUsed=id;}
    else if(cmd==='pet_changeformation'){
      const plan=own(r.pet.formation.plan,r.pet.formation.planOnUsed,()=>new Map()),source=p.source,target=p.target;if(!Array.isArray(source)||!Array.isArray(target))throw new Error('阵位参数无效');
      const [a,ai]=source.map(Number),[b,bi]=target.map(Number),set=(index,id)=>{if(index===0)r.pet.fightId=id;else if(index>0)plan.set(index,id);};set(ai,bi<0?0:b);set(bi,a);
    }
    else if(cmd==='pet_pettrain'){if(!pet)throw new Error('鬼仆不存在');pet.passiveSkill=pet.passiveSkill.map(([id,level])=>[id,Math.min(c.PetSkillCfg.getById(id)?.levelMax||10,level+1)]);}
    else if(cmd==='pet_petrefine'){if(!pet)throw new Error('鬼仆不存在');pet.passiveSkillTmp=c.PetSkillCfg.list.filter(x=>x.quality<=pet.quality).sort(()=>Math.random()-.5).slice(0,c.PetQualityCfg.getById(pet.quality)?.skillNum||3).map(x=>[x.id,1]);pet.refineCount++;}
    else if(cmd==='pet_petrefineapply'){if(!pet)throw new Error('鬼仆不存在');if(p.accept&&pet.passiveSkillTmp.length)pet.passiveSkill=pet.passiveSkillTmp;pet.passiveSkillTmp=[];}
    else if(cmd==='pet_petmerge'||cmd==='pet_opensamsara'){if(!pet)throw new Error('鬼仆不存在');pet.quality=Math.min(Math.max(...c.PetQualityCfg.list.map(x=>x.id)),pet.quality+1);pet.mergerCount++;}
    else return undefined;
    stats();commit();emit('PetHatchComplete','PetFormationChange','popFightPowerUp');return{items};
  }
  function pillAction(cmd,p){
    const items=[];
    if(cmd==='hero_pillmake'){
      const cfg=c.PillFurnaceConfig.getById(Number(p.id));if(!cfg)throw new Error('丹方不存在');const num=integer(p.num),counts=new Map();for(let i=0;i<num;i++){const id=weighted(cfg.items,cfg.probability);counts.set(id,(counts.get(id)||0)+1);}for(const [id,n]of counts){tools.addItem(id,n);items.push(tools.rewardItem(id,n));}
    }else if(cmd==='hero_pilleat'){
      const selected=p.pills instanceof Map?p.pills:new Map(c.PillConfig.list.filter(x=>x.type===Number(p.pillType)&&(r.bag.get(x.itemId)?.n||0)>0).map(x=>[x.id,r.bag.get(x.itemId).n]));
      for(const [id,value]of selected){const cfg=c.PillConfig.getById(Number(id))||c.PillConfig.list.find(x=>x.itemId===Number(id));if(!cfg)throw new Error('丹药不存在');const n=integer(value,1,9999999);if(cfg.type===1)r.hero.pillEatNum.set(cfg.id,(r.hero.pillEatNum.get(cfg.id)||0)+n);else r.hero.pillEatTime.set(cfg.id,Date.now()+100*365*86400000);const bag=r.bag.get(cfg.itemId);if(bag)bag.n=Math.max(0,bag.n-n);}
    }else if(cmd==='hero_pillrecycle'){
      const cfg=c.RecycleCfg.getById(Number(p.cfgId));if(!cfg)throw new Error('转化配方不存在');const num=integer(p.num||1);for(const x of cfg.items||[]){tools.addItem(x.item,x.num*num);items.push(tools.rewardItem(x.item,x.num*num));}
    }else return undefined;
    stats();commit();emit('PillEat','PillRecycle','popFightPowerUp');return{items};
  }
  function baseAction(cmd,p){
    const b=r.roleBase,id=Number(p.skinId),cfg=c.BaseSkinCfg.getById(id);
    if(cmd==='rolebase_baseupgrade'||cmd==='rolebase_basebreakup')b.level=Math.min(Math.max(...c.BaseCfg.list.map(x=>x.id)),b.level+1);
    else if(cmd==='rolebase_baseactivationskin'||cmd==='rolebase_baseskinstarup'){if(!cfg)throw new Error('水晶法相不存在');b.skinLevel.set(id,Math.min(Math.max(1,cfg.cost.length),(b.skinLevel.get(id)||0)+1));}
    else if(cmd==='rolebase_basewearskin'){if(!cfg)throw new Error('水晶法相不存在');b.skin=id;}
    else if(cmd==='rolebase_baseupgradeskill'){const id=Number(p.skillId),cfg=c.SkillBookCfg.getById(id);if(!cfg)throw new Error('水晶技能不存在');b.skill.set(id,Math.min(cfg.levelMax,(b.skill.get(id)||0)+1));}
    else if(cmd==='rolebase_baseactivationcollect')b.collect=Math.max(...(c.SkinCollectionCfg?.list||[]).map(x=>x.unlockLevel),b.collect);
    else return undefined;
    stats();commit();emit('BaseInfoUpgrade','BaseInfoCollectUpgrade','popFightPowerUp');return{};
  }
  function desireAction(cmd,p){
    const bag=r.desire.bag,g=r.desire.cardGame;let items=[];
    if(cmd==='desire_cardgamestart'){g.num=integer(p.num,1,100);g.info.clear();g.progress.clear();r.desire.cardGameCnt++;}
    else if(cmd==='desire_cardgameturnover'){
      const index=Number(p.cardIdx);if(!Number.isInteger(index)||index<0||index>=10)throw new Error('翻牌位置无效');if(g.num<=0)g.num=1;
      const type=weighted([1,2,3],[6500,1500,2000]);g.info.set(index,type);g.progress.set(type,(g.progress.get(type)||0)+1);
      if(g.info.size>=10){const quality=Math.min(8,2+(g.progress.get(3)||0));const pool=c.DesireCfg.list.filter(x=>x.itemId.quality===quality);for(let i=0;i<g.num;i++){const cfg=choose(pool.length?pool:c.DesireCfg.list);addDesire(cfg.id,1);items.push(tools.rewardItem(cfg.id,1));}g.num=0;}
    }else if(cmd==='desire_embedgem'){
      const id=Number(p.id),plan=own(r.desire.plan,Number(p.planIdx),()=>new Map());if(p.equiped){if(!bag.has(id))throw new Error('三尸物品不存在');plan.set(Number(p.planPos),id);}else plan.delete(Number(p.planPos));
    }else if(cmd==='desire_switchplan')r.desire.planOnUsed=Number(p.planIdx??p.id??0);
    else if(cmd==='desire_changeplanname')r.desire.planName.set(Number(p.planIdx??p.id??0),String(p.name||'方案').slice(0,20));
    else if(cmd==='desire_lockgem'){const item=bag.get(Number(p.id));if(!item)throw new Error('三尸物品不存在');item.locked=Boolean(p.locked);commit();return{newBagId:item.id};}
    else if(cmd==='desire_refinegem'){const item=bag.get(Number(p.itemId));if(!item)throw new Error('三尸物品不存在');const cfg=c.DesireCfg.getById(item.cfgId),pool=c.DesireCfg.list.filter(x=>x.type===cfg.type&&x.itemId.quality===cfg.itemId.quality);item.cfgId=choose(pool).id;stats();commit();return{newBagId:item.id};}
    else if(cmd==='desire_composegemallpreview')return{costItemMap:new Map()};
    else if(cmd==='desire_composegem'||cmd==='desire_composegemall'){
      const input=cmd.endsWith('all')?[...bag.values()].filter(x=>!x.locked):Array.from(p.itemIds||[]).map(id=>bag.get(Number(id))).filter(Boolean);if(!input.length)throw new Error('请选择合成的三尸物品');const first=c.DesireCfg.getById(input[0].cfgId),pool=c.DesireCfg.list.filter(x=>x.type===first.type&&x.itemId.quality===first.itemId.quality+1);if(!pool.length)throw new Error('已是最高品质');const cfg=choose(pool);addDesire(cfg.id,1);items=[tools.rewardItem(cfg.id,1)];
    }else return undefined;
    stats();commit();emit('DesireChanged','DesireCardGame','popFightPowerUp');return{items,result:true};
  }
  function createEquipment(configId){
    const cfg=c.EquipmentCfg.getById(Number(configId));if(!cfg)throw new Error('脸谱配置不存在');
    const item=new d.GDEquipmentItem();item.id=Math.max(0,...r.equipment.bag.keys())+1;item.configId=cfg.id;
    r.equipment.bag.set(item.id,item);return item;
  }
  function equipmentAction(cmd,p){
    const e=r.equipment,id=Number(p.id),item=e.bag.get(id),cfg=c.EquipmentCfg.getById(item?.configId);let items=[];
    const plan=own(e.plan,e.usePlan||1,()=>new d.GdEquipmentPlan());
    if(cmd==='equipment_equip'){if(!item)throw new Error('脸谱不存在');plan.slot.set(Number(p.slot),id);e.slot.set(id,Number(p.slot));}
    else if(cmd==='equipment_unequip')plan.slot.delete(Number(p.slot));
    else if(cmd==='equipment_upgrade'){if(!cfg)throw new Error('脸谱不存在');const level=Math.min(cfg.levelLimit,(e.level.get(cfg.equipmentType)||0)+1);e.level.set(cfg.equipmentType,level);item.level=level;}
    else if(cmd==='equipment_batchequip'){for(let slot=1;slot<=8;slot++){const candidates=[...e.bag.values()].filter(x=>c.EquipmentCfg.getById(x.configId)?.equipmentType===slot).sort((a,b)=>c.EquipmentCfg.getById(b.configId).quality-c.EquipmentCfg.getById(a.configId).quality);if(candidates.length)plan.slot.set(slot,candidates[0].id);}}
    else if(cmd==='equipment_switchplan'){const id=integer(p.planId??p.id??p.idx,1,100);own(e.plan,id,()=>new d.GdEquipmentPlan());e.usePlan=id;}
    else if(cmd==='equipment_changeplanname'){own(e.plan,integer(p.planId??p.id??p.idx,1,100),()=>new d.GdEquipmentPlan()).planName=String(p.name||'方案').slice(0,20);}
    else if(cmd==='equipment_lock'){if(!item)throw new Error('脸谱不存在');item.flag=p.locked?1:0;}
    else if(cmd==='equipment_clearnew'){}
    else if(cmd==='equipment_decompose'){for(const id of p.ids||[]){const item=e.bag.get(Number(id)),cfg=c.EquipmentCfg.getById(item?.configId);if(!cfg)continue;for(const x of cfg.dismantleRewards||[]){tools.addItem(x.item,x.num);items.push(tools.rewardItem(x.item,x.num));}}}
    else if(cmd==='equipment_returnmeta'){if(!cfg)throw new Error('脸谱不存在');for(const x of cfg.returnRewards||[]){tools.addItem(x.item,x.num);items.push(tools.rewardItem(x.item,x.num));}}
    else if(cmd==='equipment_forging'){
      const source=e.bag.get(Number(p.source)),sourceCfg=c.EquipmentCfg.getById(source?.configId),choices=c.EquipmentCfg.list.filter(x=>!sourceCfg||x.equipmentType===sourceCfg.equipmentType&&x.quality>=sourceCfg.quality);const made=createEquipment(choose(choices).id);const reward=new d.RewardItem();reward.rewardType=d.ERewardItemType.equip;reward.data=made;items=[reward];
    }else return undefined;
    stats();commit();emit('EquipmentChanged','EquipmentUpgrade','popFightPowerUp');return{items,result:true};
  }
  function magicAction(cmd,p){
    const magic=r.magic,id=Number(p.magicId),weapon=magic.magicWeapon.get(id),cfg=c.MagicArtifactBaseCfg.getById(id);
    if(cmd==='magic_upgrademagicweapon'){if(!weapon||!cfg)throw new Error('法器不存在');weapon.level=Math.min(cfg.cost.length,weapon.level+1);}
    else if(cmd==='magic_usemagicweapon'){if(!weapon)throw new Error('法器不存在');magic.onUseMagic=id;}
    else if(cmd==='magic_changemagicweaponname'){if(!weapon)throw new Error('法器不存在');weapon.name=String(p.name||'').slice(0,20);}
    else if(cmd==='magic_upgradegemstone'){const id=Number(p.gemstoneId),stone=magic.gemstone.get(id),cfg=c.MagicArtifactStoneCfg.getById(id);if(!stone||!cfg)throw new Error('敕令不存在');stone.level=Math.min(cfg.cost.length,stone.level+1);}
    else if(cmd==='magic_embedgemstone'){if(!weapon)throw new Error('法器不存在');const pos=Number(p.position),stone=Number(p.gemstoneId);if(p.equipped){if(!magic.gemstone.has(stone))throw new Error('敕令不存在');weapon.chessboard.set(pos,stone);}else weapon.chessboard.delete(pos);}
    else if(cmd==='magic_upgradecollection')magic.collectionLevel=Math.min(c.MagicArtifactCollectionCfg.list.length,magic.collectionLevel+1);
    else if(cmd==='magic_refineentry'){
      const plan=own(magic.plan,magic.onUsePlan||1,()=>new d.GDMagicPlan());for(let slot=1;slot<=6;slot++){if((plan.entry.get(slot)?.flag||0)&(1<<d.MagicEntryFlagBit.lock))continue;const cfg=choose(c.MagicArtifactEntryCfg.list),entry=new d.GDMagicEntry();entry.cfgId=cfg.id;entry.value=Math.max(1,Math.round(cfg.base*(.5+Math.random())));entry.flag=1;plan.entry.set(slot,entry);}magic.refineCount++;magic.refineLevel=Math.min(c.MagicArtifactTemperCfg.list.length,magic.refineLevel+1);
    }else if(cmd==='magic_switchplan')magic.onUsePlan=Number(p.planId??p.id);
    else if(cmd==='magic_changeplanname')own(magic.plan,Number(p.planId??p.id),()=>new d.GDMagicPlan()).name=String(p.name||'方案').slice(0,20);
    else if(cmd==='magic_setrefinesetting')Object.assign(own(magic.plan,magic.onUsePlan||1,()=>new d.GDMagicPlan()).setting,{entryId:p.entryId,quality:Number(p.quality),rate:Number(p.rate)});
    else if(cmd==='magic_lockentry'||cmd==='magic_unlockentry'){const plan=own(magic.plan,Number(p.planId)||magic.onUsePlan||1,()=>new d.GDMagicPlan()),index=p.index instanceof Map?p.index:new Map([[Number(p.index),cmd==='magic_lockentry']]);index.forEach((locked,key)=>{const entry=plan.entry.get(Number(key));if(entry)entry.flag=locked?entry.flag|(1<<d.MagicEntryFlagBit.lock):entry.flag&~(1<<d.MagicEntryFlagBit.lock);});}
    else return undefined;
    stats();commit();emit('MagicArtifactChanged','popFightPowerUp');return{};
  }
  async function handle(cmd,p){
    if(!r)return undefined;
    if(cmd.startsWith('pet_'))return petAction(cmd,p);
    if(cmd.startsWith('hero_pill'))return pillAction(cmd,p);
    if(cmd.startsWith('rolebase_'))return baseAction(cmd,p);
    if(cmd.startsWith('desire_'))return desireAction(cmd,p);
    if(cmd.startsWith('equipment_'))return equipmentAction(cmd,p);
    if(cmd.startsWith('magic_'))return magicAction(cmd,p);
    if(cmd==='role_getachievementreward'){
      const items=[];for(const id of p.idList||[]){const cfg=c.AchieveTaskCfg.getById(Number(id));if(!cfg)throw new Error('成就配置不存在');for(const gift of cfg.extraReward||[]){tools.addItem(gift.item,gift.num);items.push(tools.rewardItem(gift.item,gift.num));}r.achievement.scores.set(cfg.achieveTaskType,(r.achievement.scores.get(cfg.achieveTaskType)||0)+cfg.getPoint);r.achievement.tasks.set(cfg.id,d.ETaskState.finish);}commit();return{items};
    }
    if(cmd==='mall_receivecardreward'||cmd==='mall_receiverechargeaward'){
      const id=Number(p.id??p.goodsId??p.cardId??p.chargeType??p.rechargeId),cfg=c.MallConfig.getById(id)||c.MallConfig.list.find(x=>x.rechargeType===id||x.rechargeId===p.rechargeId);if(!cfg)throw new Error('礼包配置不存在');return{items:cfg.exreward?tools.grantLocalGiftItems(tools.fixedRewards(cfg.exreward.id)):[]};
    }
    if(cmd==='system_adcallback'&&Number(p.adId)===7){const egg=c.ItemCfg.list.find(x=>x.type===c.ItemType.PET_ITEM);if(!egg)throw new Error('阴契配置缺失');tools.addItem(egg.id,1);commit();return{items:[tools.rewardItem(egg.id,1)]};}
    if(cmd==='role_getbookreward'){const cfg=c.HandBookCfg.getById(Number(p.id));if(!cfg)throw new Error('图鉴不存在');return{items:tools.grantLocalGiftItems(tools.fixedRewards(cfg.rewardId))};}
    if(cmd==='role_gettaskreward'||cmd==='role_gettaskrewardbatch'){
      const items=[];for(const id of p.ids||[p.id]){const cfg=c.TaskCfg.getById(Number(id));if(!cfg)throw new Error('任务不存在');for(const gift of cfg.extraReward||[]){tools.addItem(gift.item,gift.num);items.push(tools.rewardItem(gift.item,gift.num));}const task=r.tasks.workingTask.get(cfg.id);if(task)task.state=d.ETaskState.finish;}commit();return{items};
    }
    if(cmd==='role_getdailyreward'){const rewards=c.DailyLuckCfg.list[0]?.rewards||[];const items=rewards.map(x=>{tools.addItem(x.item,x.num);return tools.rewardItem(x.item,x.num);});commit();return{items};}
    if(cmd==='system_adcallback'&&![5,9,10].includes(Number(p.adId))){const cfg=c.AdCfg.getById(Number(p.adId));if(!cfg)throw new Error('奖励配置不存在');const items=cfg.rewardItem.map(x=>{tools.addItem(x.item,x.num);return tools.rewardItem(x.item,x.num);});commit();return{items};}
    return undefined;
  }
  function battleData(fighter){
    fighter.base=tools.hydrate(new d.GDRoleBase(),tools.plain(r.roleBase));
    const pet=r.pet.bag.get(r.pet.fightId);if(pet)fighter.pet=tools.hydrate(new d.BattlePet(),tools.plain(pet));
    if(pet)for(const [id,level]of pet.passiveSkill)for(const skill of c.PetSkillCfg.getById(id)?.skillId||[])fighter.petSkill.set(skill,level);
    r.roleBase.skill.forEach((level,id)=>{fighter.skillLevel.set(id,level);});
    r.desire.plan.get(r.desire.planOnUsed)?.forEach(id=>{for(const skill of c.DesireCfg.getById(r.desire.bag.get(id)?.cfgId)?.skill||[])fighter.equipSkills.set(skill,1);});
    const weapon=r.magic.magicWeapon.get(r.magic.onUseMagic);if(weapon){fighter.magic.level=r.magic.refineLevel;Object.assign(fighter.magic.weapon,{cfgId:weapon.cfgId,level:weapon.level,name:weapon.name});for(const skill of c.MagicArtifactBaseCfg.getById(weapon.cfgId)?.skill||[])fighter.magic.skills.set(skill,weapon.level);}
  }
  globalThis.LocalUnlocked={prepare,handle,grantItem,activatePurchase,battleData};
})();
