# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
SUPPORTED_ESCROW_CHAIN_IDS = (4_221,)
AUDITED_PAYOUT_FACTORY_4221 = "0x944fdadd826c2a159c63cb100db174716ccd1317"
from genlayer import*
import genlayer.gl._internal.gl_call as _a
from genlayer.py.evm.calldata import MethodEncoder,decode as _b
import datetime,json
_c='LIQUIDITY_ARENA_V8'
_d='CRYPTO_SPOT_1M_MEDIAN_V1'
_e='IDEMPOTENT_EVM_VAULT_V1'
_f='OPEN'
_g='RESOLVED'
_h='TIMED_OUT'
_i='PENDING'
_j='DETERMINED'
_k='TIMEOUT'
_l='HIGH'
_m='LOW'
_n=_l,_m
_o='TIE'
_p='PENDING'
_q='PARIMUTUEL'
_r='REFUND_TIE'
_s='REFUND_UNBACKED_WINNER'
_t='REFUND_NO_LOSING_SIDE'
_u='REFUND_TIMEOUT'
_v=_r,_s,_t,_u
_w='[EXPECTED]'
_x='[EXTERNAL]'
_y='[TRANSIENT]'
_z=3600
_A=2400
_B=1200
_C=120
_D=86400
_E=2678400
_F=3600
_G=93600
_H='0x'+'0'*40
_I=200
_J=10000
_K=100000000
_L=1000000000
_M=10**22
_N=100000
_O=3
_P=512000
_Q=50
_R='PREPARING'
_S='DISPATCHED'
_T='FUNDED_IN_ESCROW'
_U='EOA_WITHDRAWN'
_V='PLAYER'
_W='FEE'
_X=3600
_Y=3
_Z='BINANCE'
_aa='OKX'
_ab='BYBIT'
_ac='GATE'
_ad='KUCOIN'
_ae=_Z,_aa,_ab,_ac,_ad
_af=('BTC','Bitcoin'),('ETH','Ethereum'),('BNB','BNB'),('SOL','Solana'),('XRP','XRP')
_ag='https://data-api.binance.vision'
_ah='https://www.okx.com'
_ai='https://api.bybit.com'
_aj='https://api.gateio.ws'
_ak='https://api.kucoin.com'
@gl.evm.contract_interface
class _al:
	class View:0
	class Write:0
_am=MethodEncoder('is_bound',(Address,),bool)
_an=MethodEncoder('protocol_version',(),str)
_ao=MethodEncoder('is_prepared',(str,Address,u256),bool)
_ap=MethodEncoder('vault_of',(str,),Address)
_aq=MethodEncoder('is_credited',(str,Address,u256),bool)
_ar=MethodEncoder('is_withdrawn',(str,Address,u256),bool)
_as=MethodEncoder('prepare',(str,Address,u256),type(None))
def _at(factory,encoder,args,result_type):calldata=encoder.encode_call(args);return _a.gl_call_generic({'EthCall':{'address':factory,'calldata':calldata}},lambda raw:_b(result_type,raw)).get()
def _au(factory,payout_id,recipient,amount_atto):calldata=_as.encode_call((payout_id,recipient,u256(amount_atto)));_a.gl_call_generic({'EthSend':{'address':factory,'calldata':calldata,'value':u256(0)}},lambda _raw:None).get()
def _av(code):raise gl.vm.UserError(f"{_w} {code}")
def _aw(code):raise gl.vm.UserError(f"{_x} {code}")
def _ax(code):raise gl.vm.UserError(f"{_y} {code}")
def _ay(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True)
def _az():return int(datetime.datetime.now(datetime.timezone.utc).timestamp())
def _aA(value):return value.as_hex.lower()
def _aB(value):
	normalized=value.strip().upper()
	if normalized not in _n:_av('OBJECTIVE')
	return normalized
def _aC(asset_id):
	normalized=asset_id.strip().upper()
	for(approved_id,label)in _af:
		if approved_id==normalized:return approved_id,label
	_av('ASSET')
def _aD(epoch_end_timestamp):return str(epoch_end_timestamp)
def _aE(epoch_key,objective):return epoch_key+'|'+objective
def _aF(epoch_key,asset_id):return epoch_key+'|'+asset_id
def _aG(epoch_key,objective,account):return epoch_key+'|'+objective+'|'+_aA(account)
def _aH(offset,limit,count):
	start=int(offset);page_limit=int(limit)
	if page_limit<=0 or page_limit>_Q:_av('PAGE_LIMIT')
	if start<0 or start>count:_av('PAGE_OFFSET')
	end=start+page_limit;return start,count if end>count else end
def _aI(venue,asset_id):
	if venue==_aa or venue==_ad:return asset_id+'-USDT'
	if venue==_ac:return asset_id+'_USDT'
	return asset_id+'USDT'
def _aJ(raw):
	if raw is None or isinstance(raw,bool):_aw('PRICE_EMPTY')
	text=str(raw).strip()
	if len(text)==0 or text.startswith('-')or'e'in text.lower():_aw('PRICE_REPRESENTATION')
	if text.startswith('+'):text=text[1:]
	pieces=text.split('.')
	if len(pieces)>2:_aw('PRICE_DECIMAL')
	whole=pieces[0]if len(pieces[0])>0 else'0';fraction=pieces[1]if len(pieces)==2 else''
	if not whole.isascii()or not whole.isdigit()or len(fraction)>0 and(not fraction.isascii()or not fraction.isdigit()):_aw('PRICE_NUMERIC')
	fraction_e8=(fraction+'0'*8)[:8];result=int(whole)*_K+int(fraction_e8 or'0')
	if result<=0 or result>_M:_aw('PRICE_DECIMAL_RANGE')
	return result
def _aK(raw,code):
	if raw is None or isinstance(raw,bool):_aw(code+'_MISSING')
	text=str(raw).strip()
	if not text.isascii()or not text.isdigit():_aw(code+'_FORMAT')
	return int(text)
def _aL(start_open_e8,end_close_e8):
	if start_open_e8<=0 or end_close_e8<=0:_aw('RETURN_PRICE_RANGE')
	return(end_close_e8-start_open_e8)*_L//start_open_e8
def _aM(values):
	if len(values)<_O or len(values)>len(_ae):_aw('MEDIAN_COUNT')
	ordered=sorted(values);count=len(ordered)
	if count==4:return(ordered[1]+ordered[2])//2
	return ordered[count//2]
def _aN(start_open,end_close):return{'start_open_e8':_aJ(start_open),'end_close_e8':_aJ(end_close)}
def _aO(venue,payload,battle_start,epoch_end):
	factor=1000;open_index=1;close_index=4;minimum_row_length=7
	if venue==_Z:rows=payload
	elif venue==_aa:
		if not isinstance(payload,dict)or str(payload.get('code',''))!='0':_aw('OKX_STATUS')
		rows=payload.get('data');minimum_row_length=9
	elif venue==_ab:
		if not isinstance(payload,dict)or int(payload.get('retCode',-1))!=0:_aw('BYBIT_STATUS')
		result=payload.get('result');rows=result.get('list')if isinstance(result,dict)else None
	elif venue==_ac:rows=payload;factor=1;open_index=5;close_index=2;minimum_row_length=8
	elif venue==_ad:
		if not isinstance(payload,dict)or str(payload.get('code',''))!='200000':_aw('KUCOIN_STATUS')
		data=payload.get('data');rows=data.get('list')if isinstance(data,dict)else data;factor=1
	else:_aw('VENUE_PARSER')
	if not isinstance(rows,list):_aw(venue+'_PAYLOAD_SCHEMA')
	start_timestamp=battle_start*factor;end_timestamp=(epoch_end-60)*factor;start_open=None;end_close=None
	for row in rows:
		if not isinstance(row,list)or len(row)<minimum_row_length:_aw(venue+'_ROW_SCHEMA')
		timestamp=_aK(row[0],venue+'_TIMESTAMP');complete=True
		if venue==_aa:complete=str(row[8])=='1'
		elif venue==_ac:complete=row[7]is True or str(row[7]).lower()=='true'
		elif venue==_Z and timestamp==end_timestamp:complete=_aK(row[6],'BINANCE_CLOSE_TIMESTAMP')<epoch_end*1000
		if timestamp==start_timestamp:
			if not complete:_aw(venue+'_OPEN_INCOMPLETE')
			start_open=row[open_index]
		if timestamp==end_timestamp:
			if not complete:_aw(venue+'_CLOSE_INCOMPLETE')
			end_close=row[close_index]
	if start_open is None or end_close is None:_aw(venue+'_CANDLES')
	return _aN(start_open,end_close)
def _aP(venue,asset_id,battle_start,epoch_end):
	symbol=_aI(venue,asset_id)
	if venue==_Z:return _ag+'/api/v3/klines?symbol='+symbol+'&interval=1m&startTime='+str(battle_start*1000)+'&endTime='+str(epoch_end*1000-1)+'&limit=20'
	if venue==_aa:return _ah+'/api/v5/market/history-candles?instId='+symbol+'&bar=1m&after='+str(epoch_end*1000)+'&limit=20'
	if venue==_ab:return _ai+'/v5/market/kline?category=spot&symbol='+symbol+'&interval=1&start='+str(battle_start*1000)+'&end='+str(epoch_end*1000-1)+'&limit=20'
	if venue==_ac:return _aj+'/api/v4/spot/candlesticks?currency_pair='+symbol+'&from='+str(battle_start)+'&to='+str(epoch_end)+'&interval=1m'
	if venue==_ad:return _ak+'/api/ua/v1/market/kline?tradeType=SPOT&symbol='+symbol+'&interval=1min&startAt='+str(battle_start)+'&endAt='+str(epoch_end)
	_aw('VENUE_SOURCE')
def _aQ(url):
	response=gl.nondet.web.get(url)
	if response.status>=500:_ax('SOURCE_UNAVAILABLE')
	if response.status>=400:_aw('SOURCE_REJECTED')
	if len(response.body)>_P:_aw('SOURCE_SIZE')
	try:return json.loads(response.body.decode('utf-8'))
	except Exception:_aw('SOURCE_JSON')
def _aR(venue,battle_start,epoch_end):
	asset_results=[]
	try:
		for(asset_id,_label)in _af:payload=_aQ(_aP(venue,asset_id,battle_start,epoch_end));prices=_aO(venue,payload,battle_start,epoch_end);asset_results.append([asset_id,_aL(prices['start_open_e8'],prices['end_close_e8'])])
	except Exception:return
	return[venue,asset_results]
def _aS(assets,objective):
	winning_return=None;winners=[]
	for item in assets:
		score=int(item[1]);better=winning_return is None or objective==_l and score>winning_return or objective==_m and score<winning_return
		if better:winning_return=score;winners=[item[0]]
		elif score==winning_return:winners.append(item[0])
	if winning_return is None:_aw('RESULT_EMPTY')
	return winners[0]if len(winners)==1 else _o,winning_return
def _aT(epoch_end):
	battle_start=epoch_end-_B;qualified=[]
	for venue in _ae:
		venue_result=_aR(venue,battle_start,epoch_end)
		if venue_result is not None:qualified.append(venue_result)
	qualified_names=[item[0]for item in qualified]
	if len(qualified)<_O:_ax('VENUE_QUORUM')
	assets=[]
	for asset_index in range(len(_af)):
		asset_id=_af[asset_index][0];venue_returns=[]
		for venue_result in qualified:
			item=venue_result[1][asset_index]
			if item[0]!=asset_id:_aw('VENUE_ASSET_ORDER')
			venue_returns.append(int(item[1]))
		assets.append([asset_id,_aM(venue_returns),venue_returns])
	return[qualified_names,assets]
def _aU(result):
	if not isinstance(result,list)or len(result)!=2:_aw('RESULT_SCHEMA')
	venues=result[0]
	if not isinstance(venues,list)or len(venues)<_O or len(venues)>len(_ae):_aw('RESULT_VENUE_COUNT')
	canonical_venues=[];next_venue_index=0
	for venue in venues:
		venue_text=str(venue);found=False
		while next_venue_index<len(_ae):
			expected_venue=_ae[next_venue_index];next_venue_index+=1
			if venue_text==expected_venue:found=True;break
		if not found:_aw('RESULT_VENUE_ORDER')
		canonical_venues.append(venue_text)
	raw_assets=result[1]
	if not isinstance(raw_assets,list)or len(raw_assets)!=len(_af):_aw('RESULT_ASSETS')
	canonical_assets=[]
	for index in range(len(_af)):
		raw_item=raw_assets[index]
		if not isinstance(raw_item,list)or len(raw_item)!=3:_aw('RESULT_ASSET_SCHEMA')
		expected_asset_id=_af[index][0]
		if str(raw_item[0])!=expected_asset_id:_aw('RESULT_ASSET_ORDER')
		raw_returns=raw_item[2]
		if not isinstance(raw_returns,list)or len(raw_returns)!=len(venues):_aw('RESULT_RETURNS')
		venue_returns=[]
		for raw_return in raw_returns:
			if isinstance(raw_return,bool):_aw('RESULT_RETURN_BOOL')
			try:venue_returns.append(int(raw_return))
			except Exception:_aw('RESULT_RETURN_VALUE')
		if isinstance(raw_item[1],bool):_aw('RESULT_MEDIAN_BOOL')
		try:median_return=int(raw_item[1])
		except Exception:_aw('RESULT_MEDIAN_VALUE')
		if median_return!=_aM(venue_returns):_aw('RESULT_MEDIAN')
		canonical_assets.append([expected_asset_id,median_return,venue_returns])
	return[canonical_venues,canonical_assets]
def _aV(leader_result,validator_result):
	leader_assets=leader_result[1];validator_assets=validator_result[1]
	if _aS(leader_assets,_l)[0]!=_aS(validator_assets,_l)[0]or _aS(leader_assets,_m)[0]!=_aS(validator_assets,_m)[0]:return False
	for index in range(len(_af)):
		leader_return=int(leader_assets[index][1]);validator_return=int(validator_assets[index][1]);difference=leader_return-validator_return
		if difference<0:difference=-difference
		if difference>_N:return False
	return True
def _aW(leaders_res,leader_fn):
	leader_message=leaders_res.message if hasattr(leaders_res,'message')else''
	try:leader_fn();return False
	except gl.vm.UserError as validator_error:
		validator_message=validator_error.message if hasattr(validator_error,'message')else str(validator_error)
		if validator_message.startswith(_y)and leader_message.startswith(_y):return True
		if validator_message.startswith(_w)or validator_message.startswith(_x):return validator_message==leader_message
		return False
	except Exception:return False
class LiquidityArenaV8(gl.Contract):
	owner:Address;keeper:Address;treasury:Address;payout_vault_factory:Address;payouts_enabled:bool;new_risk_enabled:bool;epoch_min_stake_atto:u256;epoch_max_stake_per_wallet_atto:u256;platform_fee_bps:u256;total_player_liability_atto:u256;accrued_platform_fees_atto:u256;reserved_platform_fees_atto:u256;funded_platform_fees_atto:u256;withdrawn_platform_fees_atto:u256;delivery_reserve_atto:u256;committed_delivery_reserve_atto:u256;reserved_player_payouts_atto:u256;fee_payout_nonce:u256;epoch_ids:DynArray[str];epoch_exists:TreeMap[str,bool];epoch_records:TreeMap[str,str];epoch_asset_records:TreeMap[str,str];objective_records:TreeMap[str,str];objective_total_stake_atto:TreeMap[str,u256];objective_participant_count:TreeMap[str,u256];objective_allocated_atto:TreeMap[str,u256];objective_funded_atto:TreeMap[str,u256];objective_paid_atto:TreeMap[str,u256];objective_unclaimed_winning_stake_atto:TreeMap[str,u256];asset_objective_stake_atto:TreeMap[str,u256];wallet_stake_atto:TreeMap[str,u256];wallet_choice_asset:TreeMap[str,str];wallet_seen:TreeMap[str,bool];wallet_claimed:TreeMap[str,bool];wallet_claimed_atto:TreeMap[str,u256];wallet_escrow_funded_atto:TreeMap[str,u256];wallet_payout_id:TreeMap[str,str];payout_ids:DynArray[str];payout_records:TreeMap[str,str]
	def __init__(self,treasury:Address,keeper:Address,epoch_min_stake_atto:u256,epoch_max_stake_per_wallet_atto:u256,payout_vault_factory:Address):
		if int(gl.message.value)!=0:_av('VALUE_NOT_ACCEPTED')
		if _aA(treasury)==_H:_av('TREASURY_ZERO')
		if _aA(keeper)==_H:_av('KEEPER_ZERO')
		if _aA(payout_vault_factory)==_H:_av('PAYOUT_FACTORY_ZERO')
		minimum_stake=int(epoch_min_stake_atto);maximum_wallet_stake=int(epoch_max_stake_per_wallet_atto)
		if minimum_stake<=0:_av('MIN_STAKE')
		if maximum_wallet_stake<minimum_stake:_av('MAX_WALLET_STAKE')
		self.owner=gl.message.sender_address;self.keeper=keeper;self.treasury=treasury;self.payout_vault_factory=payout_vault_factory;self.payouts_enabled=False;self.new_risk_enabled=False;self.epoch_min_stake_atto=u256(minimum_stake);self.epoch_max_stake_per_wallet_atto=u256(maximum_wallet_stake);self.platform_fee_bps=u256(_I);self.total_player_liability_atto=u256(0);self.accrued_platform_fees_atto=u256(0);self.reserved_platform_fees_atto=u256(0);self.funded_platform_fees_atto=u256(0);self.withdrawn_platform_fees_atto=u256(0);self.delivery_reserve_atto=u256(0);self.committed_delivery_reserve_atto=u256(0);self.reserved_player_payouts_atto=u256(0);self.fee_payout_nonce=u256(0)
	def _aX(self):
		if int(gl.message.value)!=0:_av('VALUE_NOT_ACCEPTED')
	def _aY(self):
		if gl.message.sender_address!=self.owner:_av('ONLY_OWNER')
	def _aZ(self):
		if not self.payouts_enabled:_av('PAYOUTS_INACTIVE')
		if not self.new_risk_enabled:_av('NEW_RISK_PAUSED')
	def _a0(self,recipient):
		sender=gl.message.sender_address
		if sender!=self.owner and sender!=self.keeper and sender!=recipient:_av('PAYOUT_OPERATOR')
	def _a1(self):
		chain_id=int(gl.message.chain_id);audited_factory=''
		if chain_id==4221:audited_factory=AUDITED_PAYOUT_FACTORY_4221
		if audited_factory==''or audited_factory==_H or _aA(self.payout_vault_factory)!=audited_factory.lower():_av('PAYOUT_FACTORY_UNTRUSTED')
		arena=gl.message.contract_address
		if not _at(self.payout_vault_factory,_am,(arena,),bool):_av('PAYOUT_FACTORY_UNBOUND')
		protocol=_at(self.payout_vault_factory,_an,(),str)
		if protocol!=_e:_av('PAYOUT_FACTORY_PROTOCOL')
	def _a2(self,kind,recipient,amount_atto,epoch_key,objective,nonce):return Keccak256(_ay({'chain_id':int(gl.message.chain_id),'contract':_aA(gl.message.contract_address),'factory':_aA(self.payout_vault_factory),'payout_protocol':_e,'kind':kind,'recipient':_aA(recipient),'amount_atto':amount_atto,'epoch_end_timestamp':int(epoch_key)if epoch_key!=''else 0,'objective':objective,'nonce':nonce}).encode('utf-8')).hexdigest()
	def _a3(self,payout_id):
		if self.payout_records.get(payout_id,'')=='':_av('PAYOUT_UNKNOWN')
		return json.loads(self.payout_records[payout_id])
	def _a4(self,payout_id,record):self.payout_records[payout_id]=_ay(record)
	def _a5(self,payout):
		if bool(payout.get('escrow_withdrawn',False)):return
		amount=int(payout['amount_atto']);kind=str(payout['kind'])
		if kind==_V:
			wallet_key=str(payout['wallet_key'])
			if self.wallet_claimed.get(wallet_key,False):_av('CLAIMED')
			objective_key=_aE(str(payout['epoch_end_timestamp']),str(payout['objective']));paid=int(self.objective_paid_atto.get(objective_key,u256(0)));funded=int(self.objective_funded_atto.get(objective_key,u256(0)))
			if paid+amount>funded:_av('PAYOUT_STATE')
			self.wallet_claimed[wallet_key]=True;self.wallet_claimed_atto[wallet_key]=u256(amount);self.objective_paid_atto[objective_key]=u256(paid+amount)
		elif kind==_W:
			withdrawn=int(self.withdrawn_platform_fees_atto);funded_fees=int(self.funded_platform_fees_atto)
			if withdrawn+amount>funded_fees:_av('FEE_FUNDED')
			self.withdrawn_platform_fees_atto=u256(withdrawn+amount)
		else:_av('PAYOUT_KIND')
		payout['escrow_withdrawn']=True;payout['withdrawn_at_timestamp']=_az();payout['state']=_U
	def _a6(self):
		liability=int(self.total_player_liability_atto);reserved=int(self.reserved_player_payouts_atto)
		if reserved>liability:_av('LIABILITY_STATE')
		return liability-reserved
	def _a7(self,additional_player_atto=0):unreserved_obligations=self._a6()+int(self.accrued_platform_fees_atto)+additional_player_atto;return unreserved_obligations*_Y
	def _a8(self,additional_player_atto=0):
		required=self._a7(additional_player_atto)
		if int(self.delivery_reserve_atto)<required:_av('PAYOUT_RESERVE_CAPACITY')
	def _a9(self,amount):
		budget=amount*_Y;available=int(self.delivery_reserve_atto)
		if budget>available:_av('PAYOUT_RESERVE')
		self.delivery_reserve_atto=u256(available-budget);self.committed_delivery_reserve_atto=u256(int(self.committed_delivery_reserve_atto)+budget);return budget
	def _ba(self):return int(self.total_player_liability_atto)+int(self.accrued_platform_fees_atto)+int(self.reserved_platform_fees_atto)+int(self.delivery_reserve_atto)+int(self.committed_delivery_reserve_atto)
	def _bb(self):
		if int(self.balance)<self._ba():_av('ACCOUNTING_INSOLVENT')
	def _bc(self):
		sender=gl.message.sender_address
		if sender!=self.owner and sender!=self.keeper:_av('EPOCH_CREATOR')
	def _bd(self):
		sender=gl.message.sender_address
		if sender!=self.owner and sender!=self.treasury:_av('FEE_OPERATOR')
	def _be(self,epoch_end_timestamp):
		epoch_end=int(epoch_end_timestamp);key=_aD(epoch_end)
		if not self.epoch_exists.get(key,False):_av('EPOCH_UNKNOWN')
		return key,json.loads(self.epoch_records[key])
	def _bf(self,record):
		if record['status']!=_f:return record['status']
		now=_az()
		if now<int(record['wager_opens_timestamp']):return'SCHEDULED'
		if now<int(record['wager_closes_timestamp']):return'WAGER_OPEN'
		if now<int(record['epoch_end_timestamp']):return'BATTLE'
		if now<int(record['resolution_available_timestamp']):return'PUBLICATION_DELAY'
		if now<int(record['timeout_refund_available_timestamp']):return'RESOLVABLE'
		return'TIMEOUT_AVAILABLE'
	def _bg(self,epoch_key,objective):return json.loads(self.objective_records[_aE(epoch_key,objective)])
	@gl.public.write
	def set_keeper(self,keeper:Address)->None:self._aX();self._aY();self.keeper=keeper
	@gl.public.write
	def activate_payouts(self)->None:
		self._aX();self._aY()
		if int(gl.message.chain_id)not in SUPPORTED_ESCROW_CHAIN_IDS:_av('PAYOUT_NETWORK_UNSUPPORTED')
		if self.payouts_enabled:_av('PAYOUTS_ACTIVE')
		self._a1();self._a8();self._bb();self.payouts_enabled=True;self.new_risk_enabled=False
	@gl.public.write
	def pause_new_risk(self)->None:
		self._aX();sender=gl.message.sender_address
		if sender!=self.owner and sender!=self.keeper:_av('PAUSE_OPERATOR')
		self.new_risk_enabled=False
	@gl.public.write
	def resume_new_risk(self)->None:
		self._aX();self._aY()
		if not self.payouts_enabled:_av('PAYOUTS_INACTIVE')
		self._a1();self._a8();self._bb();self.new_risk_enabled=True
	@gl.public.write.payable
	def fund_delivery_reserve(self)->None:
		amount=int(gl.message.value)
		if amount<=0:_av('RESERVE_AMOUNT')
		self.delivery_reserve_atto=u256(int(self.delivery_reserve_atto)+amount)
	@gl.public.write
	def create_epoch(self,epoch_end_timestamp:u256)->None:
		self._aX();self._aZ();self._bc();epoch_end=int(epoch_end_timestamp);minimum_stake=int(self.epoch_min_stake_atto);maximum_wallet_stake=int(self.epoch_max_stake_per_wallet_atto);now=_az()
		if epoch_end<=0 or epoch_end%_z!=0:_av('EPOCH_HOURLY')
		wager_opens=epoch_end-_A;wager_closes=epoch_end-_B;creation_lead=epoch_end-now
		if creation_lead<_F:_av('EPOCH_NOTICE')
		if gl.message.sender_address==self.keeper and creation_lead>_G:_av('KEEPER_EPOCH_AHEAD')
		if creation_lead>_E:_av('EPOCH_AHEAD')
		key=_aD(epoch_end)
		if self.epoch_exists.get(key,False):_av('EPOCH_DUPLICATE')
		fee_snapshot=int(self.platform_fee_bps);record={'epoch_id':key,'epoch_end_timestamp':epoch_end,'wager_opens_timestamp':wager_opens,'wager_closes_timestamp':wager_closes,'battle_starts_timestamp':wager_closes,'resolution_available_timestamp':epoch_end+_C,'timeout_refund_available_timestamp':epoch_end+_D,'created_at_timestamp':now,'creator':_aA(gl.message.sender_address),'status':_f,'result_status':_i,'policy_version':_d,'platform_fee_bps_snapshot':fee_snapshot,'min_stake_atto':minimum_stake,'max_stake_per_wallet_atto':maximum_wallet_stake,'qualified_venues':[],'venue_count':0,'high_winner_asset_id':'','high_winner_return_ppb':0,'low_winner_asset_id':'','low_winner_return_ppb':0,'resolved_at_timestamp':0,'resolution_digest':'','platform_fee_accrued_atto':0};self.epoch_records[key]=_ay(record);self.epoch_exists[key]=True
		for(asset_id,label)in _af:
			self.epoch_asset_records[_aF(key,asset_id)]=_ay({'asset_id':asset_id,'label':label,'return_ppb':0,'venue_returns_ppb':[]})
			for objective in _n:self.asset_objective_stake_atto[_aE(_aF(key,asset_id),objective)]=u256(0)
		for objective in _n:objective_key=_aE(key,objective);self.objective_records[objective_key]=_ay({'epoch_id':key,'objective':objective,'settlement_mode':_p,'winner_asset_id':'','winner_return_ppb':0,'payout_pool_atto':0,'winning_stake_atto':0,'losing_stake_atto':0,'platform_fee_atto':0});self.objective_total_stake_atto[objective_key]=u256(0);self.objective_participant_count[objective_key]=u256(0);self.objective_allocated_atto[objective_key]=u256(0);self.objective_funded_atto[objective_key]=u256(0);self.objective_paid_atto[objective_key]=u256(0);self.objective_unclaimed_winning_stake_atto[objective_key]=u256(0)
		self.epoch_ids.append(key)
	@gl.public.write.payable
	def enter(self,epoch_end_timestamp:u256,objective:str,asset_id:str)->None:
		self._aZ();epoch_key,record=self._be(epoch_end_timestamp)
		if record['status']!=_f:_av('EPOCH_NOT_OPEN')
		now=_az()
		if now<int(record['wager_opens_timestamp']):_av('WAGER_NOT_STARTED')
		if now>=int(record['wager_closes_timestamp']):_av('WAGER_CLOSED')
		normalized_objective=_aB(objective);normalized_asset_id,_label=_aC(asset_id);amount=int(gl.message.value)
		if amount<=0:_av('STAKE_POSITIVE')
		if amount<int(record['min_stake_atto']):_av('STAKE_MINIMUM')
		account=gl.message.sender_address;wallet_key=_aG(epoch_key,normalized_objective,account);current=int(self.wallet_stake_atto.get(wallet_key,u256(0)));existing_choice=self.wallet_choice_asset.get(wallet_key,'')
		if existing_choice!=''and existing_choice!=normalized_asset_id:_av('ONE_ASSET_PER_OBJECTIVE')
		projected=current+amount
		if projected>int(record['max_stake_per_wallet_atto']):_av('WALLET_STAKE_CAP')
		self._a8(amount);objective_key=_aE(epoch_key,normalized_objective);asset_stake_key=_aE(_aF(epoch_key,normalized_asset_id),normalized_objective);self.wallet_choice_asset[wallet_key]=normalized_asset_id;self.wallet_stake_atto[wallet_key]=u256(projected);self.objective_total_stake_atto[objective_key]=u256(int(self.objective_total_stake_atto.get(objective_key,u256(0)))+amount);self.asset_objective_stake_atto[asset_stake_key]=u256(int(self.asset_objective_stake_atto.get(asset_stake_key,u256(0)))+amount);self.total_player_liability_atto=u256(int(self.total_player_liability_atto)+amount)
		if not self.wallet_seen.get(wallet_key,False):self.wallet_seen[wallet_key]=True;self.objective_participant_count[objective_key]=u256(int(self.objective_participant_count.get(objective_key,u256(0)))+1)
	def _bh(self,epoch_key,objective,mode,winner,winner_return):objective_key=_aE(epoch_key,objective);total_stake=int(self.objective_total_stake_atto.get(objective_key,u256(0)));record=self._bg(epoch_key,objective);record['settlement_mode']=mode;record['winner_asset_id']=winner;record['winner_return_ppb']=winner_return;record['payout_pool_atto']=total_stake;record['winning_stake_atto']=0;record['losing_stake_atto']=0;record['platform_fee_atto']=0;self.objective_unclaimed_winning_stake_atto[objective_key]=u256(0);self.objective_records[objective_key]=_ay(record)
	def _bi(self,epoch_key,epoch_record,objective,winner,winner_return):
		objective_key=_aE(epoch_key,objective);total_stake=int(self.objective_total_stake_atto.get(objective_key,u256(0)))
		if winner==_o:self._bh(epoch_key,objective,_r,winner,winner_return);return 0
		winning_stake=int(self.asset_objective_stake_atto.get(_aE(_aF(epoch_key,winner),objective),u256(0)))
		if winning_stake==0:self._bh(epoch_key,objective,_s,winner,winner_return);return 0
		losing_stake=total_stake-winning_stake
		if losing_stake==0:self._bh(epoch_key,objective,_t,winner,winner_return);return 0
		fee_bps=int(epoch_record['platform_fee_bps_snapshot']);fee=losing_stake*fee_bps//_J;payout_pool=total_stake-fee;record=self._bg(epoch_key,objective);record['settlement_mode']=_q;record['winner_asset_id']=winner;record['winner_return_ppb']=winner_return;record['payout_pool_atto']=payout_pool;record['winning_stake_atto']=winning_stake;record['losing_stake_atto']=losing_stake;record['platform_fee_atto']=fee;self.objective_unclaimed_winning_stake_atto[objective_key]=u256(winning_stake);self.objective_records[objective_key]=_ay(record)
		if fee>0:
			liability=int(self.total_player_liability_atto)
			if fee>liability:_av('LIABILITY_STATE')
			self.total_player_liability_atto=u256(liability-fee);self.accrued_platform_fees_atto=u256(int(self.accrued_platform_fees_atto)+fee)
		return fee
	@gl.public.write
	def resolve_epoch(self,epoch_end_timestamp:u256)->None:
		self._aX();epoch_key,record=self._be(epoch_end_timestamp)
		if record['status']!=_f:_av('EPOCH_NOT_OPEN')
		epoch_end=int(record['epoch_end_timestamp']);now=_az()
		if now<int(record['resolution_available_timestamp']):_av('RESOLUTION_GATE')
		if now>=int(record['timeout_refund_available_timestamp']):_av('RESOLUTION_TIMEOUT')
		def leader_fn()->list:return _aT(epoch_end)
		def validator_fn(leaders_res:gl.vm.Result)->bool:
			if not isinstance(leaders_res,gl.vm.Return):return _aW(leaders_res,leader_fn)
			try:leader_result=_aU(leaders_res.calldata);validator_result=_aU(leader_fn());return _aV(leader_result,validator_result)
			except Exception:return False
		result=gl.vm.run_nondet_unsafe(leader_fn,validator_fn);canonical=_aU(result);venues=canonical[0];assets=canonical[1];record['status']=_g;record['result_status']=_j;record['qualified_venues']=venues;record['venue_count']=len(venues);record['resolved_at_timestamp']=now;public_assets=[]
		for item in assets:public_item={'asset_id':item[0],'return_ppb':item[1],'venue_returns_ppb':item[2]};public_assets.append(public_item);asset_record=json.loads(self.epoch_asset_records[_aF(epoch_key,item[0])]);asset_record['return_ppb']=item[1];asset_record['venue_returns_ppb']=item[2];self.epoch_asset_records[_aF(epoch_key,item[0])]=_ay(asset_record)
		high_winner,high_return=_aS(assets,_l);low_winner,low_return=_aS(assets,_m);record['high_winner_asset_id']=high_winner;record['high_winner_return_ppb']=high_return;record['low_winner_asset_id']=low_winner;record['low_winner_return_ppb']=low_return;high_fee=self._bi(epoch_key,record,_l,high_winner,high_return);low_fee=self._bi(epoch_key,record,_m,low_winner,low_return);record['platform_fee_accrued_atto']=high_fee+low_fee;canonical_result={'policy_version':_d,'status':_j,'epoch_end_timestamp':epoch_end,'qualified_venues':venues,'venue_count':len(venues),'assets':public_assets,'high_winner_asset_id':high_winner,'high_winner_return_ppb':high_return,'low_winner_asset_id':low_winner,'low_winner_return_ppb':low_return};record['resolution_digest']=Keccak256(_ay(canonical_result).encode('utf-8')).hexdigest();self.epoch_records[epoch_key]=_ay(record)
	@gl.public.write
	def activate_timeout_refund(self,epoch_end_timestamp:u256)->None:
		self._aX();epoch_key,record=self._be(epoch_end_timestamp)
		if record['status']!=_f:_av('EPOCH_NOT_OPEN')
		if _az()<int(record['timeout_refund_available_timestamp']):_av('TIMEOUT_EARLY')
		self._bh(epoch_key,_l,_u,'',0);self._bh(epoch_key,_m,_u,'',0);record['status']=_h;record['result_status']=_k;record['resolved_at_timestamp']=_az();record['resolution_digest']=Keccak256(_ay({'epoch_end_timestamp':int(record['epoch_end_timestamp']),'policy_version':_d,'status':_k}).encode('utf-8')).hexdigest();self.epoch_records[epoch_key]=_ay(record)
	def _bj(self,epoch_key,objective,account):
		objective_key=_aE(epoch_key,objective);objective_record=self._bg(epoch_key,objective);wallet_key=_aG(epoch_key,objective,account);stake=int(self.wallet_stake_atto.get(wallet_key,u256(0)));choice=self.wallet_choice_asset.get(wallet_key,'');claimed=self.wallet_claimed.get(wallet_key,False);claimed_atto=int(self.wallet_claimed_atto.get(wallet_key,u256(0)));escrow_funded_atto=int(self.wallet_escrow_funded_atto.get(wallet_key,u256(0)));payout_id=self.wallet_payout_id.get(wallet_key,'');payout_state='';mode=str(objective_record['settlement_mode']);amount=0;includes_rounding_remainder=False
		if payout_id!='':payout=self._a3(payout_id);payout_state=str(payout['state']);amount=int(payout['amount_atto']);includes_rounding_remainder=bool(payout.get('includes_rounding_remainder',False))
		elif not claimed and stake>0:
			if mode in _v:amount=stake
			elif mode==_q and choice==objective_record['winner_asset_id']:
				winning_stake=int(objective_record['winning_stake_atto']);payout_pool=int(objective_record['payout_pool_atto']);allocated=int(self.objective_allocated_atto.get(objective_key,u256(0)));remaining_winning_stake=int(self.objective_unclaimed_winning_stake_atto.get(objective_key,u256(0)))
				if winning_stake<=0 or stake>remaining_winning_stake:_av('PAYOUT_STATE')
				includes_rounding_remainder=stake==remaining_winning_stake;amount=payout_pool-allocated if includes_rounding_remainder else stake*payout_pool//winning_stake
		return{'epoch_end_timestamp':int(epoch_key),'objective':objective,'account':account,'choice_asset_id':choice,'stake_atto':stake,'settlement_mode':mode,'eligible':not claimed and payout_id==''and amount>0,'claimed':claimed,'claimed_atto':claimed_atto,'escrow_funded_atto':escrow_funded_atto,'amount_atto':amount,'includes_rounding_remainder':includes_rounding_remainder,'payout_id':payout_id,'payout_state':payout_state}
	@gl.public.write
	def claim(self,epoch_end_timestamp:u256,objective:str)->None:
		self._aX()
		if not self.payouts_enabled:_av('PAYOUTS_INACTIVE')
		epoch_key,_epoch_record=self._be(epoch_end_timestamp);normalized_objective=_aB(objective);objective_key=_aE(epoch_key,normalized_objective);objective_record=self._bg(epoch_key,normalized_objective)
		if objective_record['settlement_mode']==_p:_av('NOT_SETTLED')
		sender=gl.message.sender_address;wallet_key=_aG(epoch_key,normalized_objective,sender)
		if self.wallet_claimed.get(wallet_key,False):_av('CLAIMED')
		if self.wallet_payout_id.get(wallet_key,'')!='':_av('PAYOUT_EXISTS')
		quote=self._bj(epoch_key,normalized_objective,sender)
		if int(quote['stake_atto'])<=0:_av('NO_STAKE')
		if int(quote['amount_atto'])<=0:_av('NOT_ELIGIBLE')
		amount=int(quote['amount_atto']);allocated=int(self.objective_allocated_atto.get(objective_key,u256(0)));payout_pool=int(objective_record['payout_pool_atto'])
		if allocated+amount>payout_pool:_av('PAYOUT_STATE')
		liability=int(self.total_player_liability_atto)
		if amount>liability:_av('LIABILITY_STATE')
		payout_id=self._a2(_V,sender,amount,epoch_key,normalized_objective,0)
		if self.payout_records.get(payout_id,'')!='':_av('PAYOUT_DUPLICATE')
		now=_az();attempt_budget=self._a9(amount);payout={'payout_id':payout_id,'kind':_V,'recipient':_aA(sender),'amount_atto':amount,'epoch_end_timestamp':int(epoch_key),'objective':normalized_objective,'wallet_key':wallet_key,'stake_atto':int(quote['stake_atto']),'settlement_mode':str(quote['settlement_mode']),'includes_rounding_remainder':bool(quote['includes_rounding_remainder']),'state':_R,'prepare_attempt_count':1,'attempt_count':0,'reserve_remaining_atto':attempt_budget,'vault':_H,'created_at_timestamp':now,'last_prepare_timestamp':now,'last_dispatch_timestamp':0,'funded_at_timestamp':0,'withdrawn_at_timestamp':0,'escrow_withdrawn':False};self.wallet_payout_id[wallet_key]=payout_id;self.reserved_player_payouts_atto=u256(int(self.reserved_player_payouts_atto)+amount);self.objective_allocated_atto[objective_key]=u256(allocated+amount)
		if objective_record['settlement_mode']==_q:remaining=int(self.objective_unclaimed_winning_stake_atto.get(objective_key,u256(0)));stake=int(quote['stake_atto']);self.objective_unclaimed_winning_stake_atto[objective_key]=u256(remaining-stake)
		self.payout_records[payout_id]=_ay(payout);self.payout_ids.append(payout_id);_au(self.payout_vault_factory,payout_id,sender,amount)
	@gl.public.write
	def request_fee_payout(self,amount_atto:u256)->None:
		self._aX()
		if not self.payouts_enabled:_av('PAYOUTS_INACTIVE')
		self._bd();amount=int(amount_atto)
		if amount<=0:_av('FEE_AMOUNT')
		accrued=int(self.accrued_platform_fees_atto)
		if amount>accrued:_av('FEE_ACCRUED')
		nonce=int(self.fee_payout_nonce);payout_id=self._a2(_W,self.treasury,amount,'','',nonce)
		if self.payout_records.get(payout_id,'')!='':_av('PAYOUT_DUPLICATE')
		attempt_budget=self._a9(amount);self.accrued_platform_fees_atto=u256(accrued-amount);self.reserved_platform_fees_atto=u256(int(self.reserved_platform_fees_atto)+amount);self.fee_payout_nonce=u256(nonce+1);payout={'payout_id':payout_id,'kind':_W,'recipient':_aA(self.treasury),'amount_atto':amount,'epoch_end_timestamp':0,'objective':'','wallet_key':'','stake_atto':0,'settlement_mode':'FEE_WITHDRAWAL','includes_rounding_remainder':False,'state':_R,'prepare_attempt_count':1,'attempt_count':0,'reserve_remaining_atto':attempt_budget,'vault':_H,'created_at_timestamp':_az(),'last_prepare_timestamp':_az(),'last_dispatch_timestamp':0,'funded_at_timestamp':0,'withdrawn_at_timestamp':0,'escrow_withdrawn':False};self.payout_records[payout_id]=_ay(payout);self.payout_ids.append(payout_id);_au(self.payout_vault_factory,payout_id,self.treasury,amount)
	@gl.public.write
	def retry_prepare_payout(self,payout_id:str)->None:
		self._aX();payout=self._a3(payout_id);recipient=Address(str(payout['recipient']))
		if str(payout['state'])!=_R:_av('PAYOUT_NOT_PREPARING')
		prepare_attempts=int(payout['prepare_attempt_count']);now=_az()
		if now<int(payout['last_prepare_timestamp'])+_X:_av('PAYOUT_PREPARE_EARLY')
		amount=int(payout['amount_atto'])
		if _at(self.payout_vault_factory,_ao,(payout_id,recipient,u256(amount)),bool):_av('PAYOUT_ALREADY_PREPARED')
		payout['prepare_attempt_count']=prepare_attempts+1;payout['last_prepare_timestamp']=now;self._a4(payout_id,payout);_au(self.payout_vault_factory,payout_id,recipient,amount)
	def _bk(self,payout_id,retry):
		payout=self._a3(payout_id);state=str(payout['state'])
		if retry:
			if state!=_S:_av('PAYOUT_NOT_DISPATCHED')
			attempt_count=int(payout['attempt_count'])
			if attempt_count>=_Y:_av('PAYOUT_ATTEMPT_CAP')
			if _az()<int(payout['last_dispatch_timestamp'])+_X:_av('PAYOUT_RETRY_EARLY')
		elif state!=_R:_av('PAYOUT_NOT_PREPARING')
		recipient=Address(str(payout['recipient']));amount=int(payout['amount_atto'])
		if not _at(self.payout_vault_factory,_ao,(payout_id,recipient,u256(amount)),bool):_av('PAYOUT_VAULT_UNPREPARED')
		vault=_at(self.payout_vault_factory,_ap,(payout_id,),Address)
		if _aA(vault)==_H:_av('PAYOUT_VAULT_ZERO')
		recorded_vault=str(payout['vault'])
		if recorded_vault!=_H and recorded_vault!=_aA(vault):_av('PAYOUT_VAULT_CHANGED')
		if retry and _at(self.payout_vault_factory,_aq,(payout_id,recipient,u256(amount)),bool):_av('PAYOUT_ALREADY_CREDITED')
		reserve_remaining=int(payout['reserve_remaining_atto']);committed=int(self.committed_delivery_reserve_atto)
		if amount>reserve_remaining or amount>committed:_av('PAYOUT_RESERVE')
		self._bb();self.committed_delivery_reserve_atto=u256(committed-amount);payout['state']=_S;payout['attempt_count']=int(payout['attempt_count'])+1;payout['reserve_remaining_atto']=reserve_remaining-amount;payout['vault']=_aA(vault);payout['last_dispatch_timestamp']=_az();self._a4(payout_id,payout);_al(vault).emit_transfer(value=u256(amount))
	@gl.public.write
	def dispatch_payout(self,payout_id:str)->None:self._aX();self._bk(payout_id,False)
	@gl.public.write
	def retry_payout(self,payout_id:str)->None:self._aX();payout=self._a3(payout_id);self._a0(Address(str(payout['recipient'])));self._bk(payout_id,True)
	@gl.public.write
	def confirm_payout(self,payout_id:str)->None:
		self._aX();payout=self._a3(payout_id)
		if str(payout['state'])!=_S:_av('PAYOUT_NOT_DISPATCHED')
		recipient=Address(str(payout['recipient']));amount=int(payout['amount_atto'])
		if not _at(self.payout_vault_factory,_aq,(payout_id,recipient,u256(amount)),bool):_av('PAYOUT_NOT_CREDITED')
		kind=str(payout['kind']);reserve_remaining=int(payout['reserve_remaining_atto']);committed=int(self.committed_delivery_reserve_atto)
		if reserve_remaining>committed:_av('PAYOUT_RESERVE')
		if kind==_V:
			liability=int(self.total_player_liability_atto)
			if amount>liability:_av('LIABILITY_STATE')
			objective_key=_aE(str(payout['epoch_end_timestamp']),str(payout['objective']));funded=int(self.objective_funded_atto.get(objective_key,u256(0)));allocated=int(self.objective_allocated_atto.get(objective_key,u256(0)))
			if funded+amount>allocated:_av('PAYOUT_STATE')
			wallet_key=str(payout['wallet_key'])
			if int(self.wallet_escrow_funded_atto.get(wallet_key,u256(0)))>0:_av('PAYOUT_FUNDED')
			self.wallet_escrow_funded_atto[wallet_key]=u256(amount);self.objective_funded_atto[objective_key]=u256(funded+amount);self.total_player_liability_atto=u256(liability-amount);reserved_player=int(self.reserved_player_payouts_atto)
			if amount>reserved_player:_av('LIABILITY_STATE')
			self.reserved_player_payouts_atto=u256(reserved_player-amount)
		elif kind==_W:
			reserved_fees=int(self.reserved_platform_fees_atto)
			if amount>reserved_fees:_av('FEE_RESERVED')
			self.reserved_platform_fees_atto=u256(reserved_fees-amount);self.funded_platform_fees_atto=u256(int(self.funded_platform_fees_atto)+amount)
		else:_av('PAYOUT_KIND')
		self.committed_delivery_reserve_atto=u256(committed-reserve_remaining);self.delivery_reserve_atto=u256(int(self.delivery_reserve_atto)+reserve_remaining+amount);payout['reserve_remaining_atto']=0;payout['state']=_T;payout['funded_at_timestamp']=_az();escrow_withdrawn=_at(self.payout_vault_factory,_ar,(payout_id,recipient,u256(amount)),bool)
		if escrow_withdrawn:self._a5(payout)
		self._a4(payout_id,payout);self._a8();self._bb()
	@gl.public.write
	def refresh_payout_withdrawal(self,payout_id:str)->None:
		self._aX();payout=self._a3(payout_id);state=str(payout['state'])
		if state==_U and bool(payout.get('escrow_withdrawn',False)):return
		if state!=_T:_av('PAYOUT_NOT_FUNDED')
		recipient=Address(str(payout['recipient']));amount=int(payout['amount_atto']);withdrawn=_at(self.payout_vault_factory,_ar,(payout_id,recipient,u256(amount)),bool)
		if not withdrawn:_av('PAYOUT_NOT_WITHDRAWN')
		self._a5(payout);self._a4(payout_id,payout)
	@gl.public.view
	def get_config(self)->dict:return{'protocol_version':_c,'policy_version':_d,'owner':self.owner,'keeper':self.keeper,'treasury':self.treasury,'payout_vault_factory':self.payout_vault_factory,'payout_protocol_version':_e,'payouts_enabled':self.payouts_enabled,'new_risk_enabled':self.new_risk_enabled,'max_payout_attempts':_Y,'prepare_retries_capped':False,'payout_retry_delay_seconds':_X,'current_platform_fee_bps':int(self.platform_fee_bps),'epoch_min_stake_atto':int(self.epoch_min_stake_atto),'epoch_max_stake_per_wallet_atto':int(self.epoch_max_stake_per_wallet_atto),'minimum_epoch_creation_lead_seconds':_F,'keeper_max_schedule_ahead_seconds':_G,'wager_open_offset_seconds':_A,'battle_open_offset_seconds':_B,'resolution_publication_delay_seconds':_C,'timeout_refund_delay_seconds':_D,'minimum_qualified_venues':_O,'asset_ids':[item[0]for item in _af],'venues':list(_ae),'validator_return_tolerance_ppb':_N,'supported_objectives':list(_n),'payout_finality':_T,'claimed_semantics':_U}
	@gl.public.view
	def get_epoch_page(self,offset:u256,limit:u256)->dict:
		count=len(self.epoch_ids);start,end=_aH(offset,limit,count);ids=[]
		for index in range(start,end):ids.append(self.epoch_ids[index])
		return{'offset':start,'next_offset':end,'total':count,'epoch_ids':ids}
	@gl.public.view
	def get_epoch(self,epoch_end_timestamp:u256)->dict:key,record=self._be(epoch_end_timestamp);record['phase']=self._bf(record);record['high']=self.get_objective(epoch_end_timestamp,_l);record['low']=self.get_objective(epoch_end_timestamp,_m);record['epoch_id']=key;return record
	@gl.public.view
	def get_epoch_asset(self,epoch_end_timestamp:u256,asset_id:str)->dict:key,_record=self._be(epoch_end_timestamp);normalized_asset_id,_label=_aC(asset_id);result=json.loads(self.epoch_asset_records[_aF(key,normalized_asset_id)]);result['high_stake_atto']=int(self.asset_objective_stake_atto.get(_aE(_aF(key,normalized_asset_id),_l),u256(0)));result['low_stake_atto']=int(self.asset_objective_stake_atto.get(_aE(_aF(key,normalized_asset_id),_m),u256(0)));return result
	@gl.public.view
	def get_objective(self,epoch_end_timestamp:u256,objective:str)->dict:key,_record=self._be(epoch_end_timestamp);normalized_objective=_aB(objective);objective_key=_aE(key,normalized_objective);record=self._bg(key,normalized_objective);total_stake=int(self.objective_total_stake_atto.get(objective_key,u256(0)));paid=int(self.objective_paid_atto.get(objective_key,u256(0)));funded=int(self.objective_funded_atto.get(objective_key,u256(0)));allocated=int(self.objective_allocated_atto.get(objective_key,u256(0)));record['total_stake_atto']=total_stake;record['participant_count']=int(self.objective_participant_count.get(objective_key,u256(0)));record['paid_atto']=paid;record['funded_in_escrow_atto']=funded;record['allocated_atto']=allocated;record['remaining_payout_atto']=int(record['payout_pool_atto'])-funded;record['unallocated_payout_atto']=int(record['payout_pool_atto'])-allocated;record['allocated_not_funded_atto']=allocated-funded;record['funded_not_withdrawn_atto']=funded-paid;record['unclaimed_winning_stake_atto']=int(self.objective_unclaimed_winning_stake_atto.get(objective_key,u256(0)));return record
	@gl.public.view
	def get_claim_quote(self,epoch_end_timestamp:u256,objective:str,account:Address)->dict:key,_record=self._be(epoch_end_timestamp);normalized_objective=_aB(objective);return self._bj(key,normalized_objective,account)
	@gl.public.view
	def get_delivery_reserve_state(self)->dict:return{'treasury':self.treasury,'current_platform_fee_bps':int(self.platform_fee_bps),'payout_protocol_version':_e,'payouts_enabled':self.payouts_enabled,'new_risk_enabled':self.new_risk_enabled,'player_liability_atto':int(self.total_player_liability_atto),'accrued_platform_fees_atto':int(self.accrued_platform_fees_atto),'reserved_platform_fees_atto':int(self.reserved_platform_fees_atto),'funded_platform_fees_atto':int(self.funded_platform_fees_atto),'withdrawn_platform_fees_atto':int(self.withdrawn_platform_fees_atto),'available_reserve_atto':int(self.delivery_reserve_atto),'committed_reserve_atto':int(self.committed_delivery_reserve_atto),'required_available_reserve_atto':self._a7(),'reserved_player_payouts_atto':int(self.reserved_player_payouts_atto),'max_payout_attempts':_Y,'prepare_retries_capped':False,'retry_delay_seconds':_X}
	@gl.public.view
	def get_payout(self,payout_id:str)->dict:return self._a3(payout_id)
	@gl.public.view
	def get_payout_page(self,offset:u256,limit:u256)->dict:
		count=len(self.payout_ids);start,end=_aH(offset,limit,count);payouts=[]
		for index in range(start,end):payout_id=self.payout_ids[index];payouts.append(self._a3(payout_id))
		return{'offset':start,'next_offset':end,'total':count,'payouts':payouts}
