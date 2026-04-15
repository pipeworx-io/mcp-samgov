interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * SAM.gov MCP — Federal contract opportunities and entity registration data
 *
 * BYO key: requires a free SAM.gov API key from https://sam.gov/content/entity-information
 * Passed via _apiKey parameter.
 *
 * Tools:
 * - sam_search_opportunities: search active federal contract opportunities
 * - sam_get_opportunity: get full details for a specific opportunity by solicitation number
 * - sam_entity_search: search registered entities/vendors in SAM
 * - sam_set_aside_opportunities: search opportunities by small business set-aside type
 */


const OPPS_BASE = 'https://api.sam.gov/opportunities/v2/search';
const ENTITY_BASE = 'https://api.sam.gov/entity-information/v3/entities';

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string;
  delete args._apiKey;
  if (!key) throw new Error('SAM.gov API key required. Get a free key at https://sam.gov/content/entity-information and pass via _apiKey.');
  return key;
}

async function samFetch(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Pipeworx/1.0 (gateway.pipeworx.io)' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAM.gov API error (${res.status}): ${text}`);
  }
  return res.json();
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'sam_search_opportunities',
    description:
      'Search active federal contract opportunities on SAM.gov. Filter by keyword, NAICS code, set-aside type, posting date range, and procurement type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        keyword: { type: 'string', description: 'Search term for opportunity title or description' },
        naics: { type: 'string', description: 'NAICS code to filter by (e.g., "541512" for computer systems design)' },
        set_aside: {
          type: 'string',
          description: 'Small business set-aside type: SBA (Small Business), SDVOSB (Service-Disabled Veteran), HUBZone, 8AN (8(a)), WOSB (Women-Owned), EDWOSB (Economically Disadvantaged Women-Owned)',
        },
        posted_from: { type: 'string', description: 'Start of posting date range in MM/dd/yyyy format' },
        posted_to: { type: 'string', description: 'End of posting date range in MM/dd/yyyy format' },
        limit: { type: 'number', description: 'Number of results to return (1-100, default 10)' },
        offset: { type: 'number', description: 'Result offset for pagination (default 0)' },
        ptype: {
          type: 'string',
          description: 'Procurement type filter: p (presolicitation), o (solicitation), k (combined synopsis/solicitation), a (award notice)',
        },
        _apiKey: { type: 'string', description: 'SAM.gov API key' },
      },
      required: ['keyword', '_apiKey'],
    },
  },
  {
    name: 'sam_get_opportunity',
    description:
      'Get full details for a specific federal contract opportunity by its solicitation number. Returns point of contact, attachments, classification, and full description.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        solicitation_number: { type: 'string', description: 'The solicitation number to look up (e.g., "W912DY-24-R-0001")' },
        _apiKey: { type: 'string', description: 'SAM.gov API key' },
      },
      required: ['solicitation_number', '_apiKey'],
    },
  },
  {
    name: 'sam_entity_search',
    description:
      'Search for registered entities (vendors/contractors) in the SAM.gov entity database. Returns UEI, CAGE code, business name, address, NAICS codes, small business status, and certifications.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        business_name: { type: 'string', description: 'Legal business name to search for' },
        naics: { type: 'string', description: 'Filter by primary NAICS code (optional)' },
        state: { type: 'string', description: 'Filter by 2-letter US state code (e.g., "VA", "CA")' },
        small_business: { type: 'boolean', description: 'Filter to only small business entities (optional)' },
        _apiKey: { type: 'string', description: 'SAM.gov API key' },
      },
      required: ['business_name', '_apiKey'],
    },
  },
  {
    name: 'sam_set_aside_opportunities',
    description:
      'Search federal contract opportunities filtered by small business set-aside type. Useful for finding opportunities reserved for specific small business categories.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        set_aside: {
          type: 'string',
          description: 'Set-aside type (required): SBA (Small Business), SDVOSB (Service-Disabled Veteran), HUBZone, 8AN (8(a)), WOSB (Women-Owned), EDWOSB (Economically Disadvantaged Women-Owned)',
        },
        keyword: { type: 'string', description: 'Optional keyword to narrow results' },
        naics: { type: 'string', description: 'Optional NAICS code filter' },
        limit: { type: 'number', description: 'Number of results to return (1-100, default 10)' },
        _apiKey: { type: 'string', description: 'SAM.gov API key' },
      },
      required: ['set_aside', '_apiKey'],
    },
  },
];

// ── callTool dispatcher ─────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);

  switch (name) {
    case 'sam_search_opportunities':
      return searchOpportunities(key, args);
    case 'sam_get_opportunity':
      return getOpportunity(key, args.solicitation_number as string);
    case 'sam_entity_search':
      return entitySearch(key, args);
    case 'sam_set_aside_opportunities':
      return setAsideOpportunities(key, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Response types ──────────────────────────────────────────────────────

type SamOpportunity = {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  department?: string;
  subTier?: string;
  office?: string;
  postedDate?: string;
  type?: string;
  baseType?: string;
  archiveType?: string;
  archiveDate?: string;
  setAside?: string;
  setAsideDescription?: string;
  responseDeadLine?: string;
  naicsCode?: string;
  classificationCode?: string;
  active?: string;
  description?: string;
  organizationType?: string;
  uiLink?: string;
  pointOfContact?: {
    fullName?: string;
    title?: string;
    email?: string;
    phone?: string;
    type?: string;
  }[];
  resourceLinks?: string[];
};

type SamOppsResponse = {
  totalRecords?: number;
  opportunitiesData?: SamOpportunity[];
};

type SamEntity = {
  entityRegistration?: {
    ueiSAM?: string;
    cageCode?: string;
    legalBusinessName?: string;
    dbaName?: string;
    registrationStatus?: string;
    registrationDate?: string;
    expirationDate?: string;
    activeDate?: string;
    physicalAddress?: {
      addressLine1?: string;
      city?: string;
      stateOrProvinceCode?: string;
      zipCode?: string;
      countryCode?: string;
    };
    businessTypes?: string[];
    primaryNaics?: string;
  };
  coreData?: {
    entityInformation?: {
      entityURL?: string;
      entityDivisionName?: string;
    };
  };
  assertions?: {
    sbaBusinessTypes?: { sbaBusinessTypeDesc?: string }[];
  };
};

type SamEntityResponse = {
  totalRecords?: number;
  entityData?: SamEntity[];
};

// ── Tool implementations ────────────────────────────────────────────────

function formatOpportunity(opp: SamOpportunity) {
  return {
    title: opp.title ?? null,
    solicitation_number: opp.solicitationNumber ?? null,
    department: opp.department ?? null,
    sub_tier: opp.subTier ?? null,
    office: opp.office ?? null,
    posted_date: opp.postedDate ?? null,
    response_deadline: opp.responseDeadLine ?? null,
    type: opp.type ?? null,
    set_aside: opp.setAsideDescription ?? opp.setAside ?? null,
    naics_code: opp.naicsCode ?? null,
    classification_code: opp.classificationCode ?? null,
    active: opp.active ?? null,
    ui_link: opp.uiLink ?? null,
  };
}

async function searchOpportunities(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({ api_key: key });
  if (args.keyword) params.set('keyword', args.keyword as string);
  if (args.naics) params.set('ncode', args.naics as string);
  if (args.set_aside) params.set('typeOfSetAside', args.set_aside as string);
  if (args.posted_from) params.set('postedFrom', args.posted_from as string);
  if (args.posted_to) params.set('postedTo', args.posted_to as string);
  if (args.ptype) params.set('ptype', args.ptype as string);

  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  params.set('limit', String(limit));
  const offset = (args.offset as number) ?? 0;
  params.set('offset', String(offset));

  const data = (await samFetch(`${OPPS_BASE}?${params}`)) as SamOppsResponse;
  const opps = data.opportunitiesData ?? [];

  return {
    total_records: data.totalRecords ?? 0,
    limit,
    offset,
    opportunities: opps.map(formatOpportunity),
  };
}

async function getOpportunity(key: string, solicitationNumber: string) {
  const params = new URLSearchParams({
    api_key: key,
    solnum: solicitationNumber,
    limit: '1',
  });

  const data = (await samFetch(`${OPPS_BASE}?${params}`)) as SamOppsResponse;
  const opps = data.opportunitiesData ?? [];

  if (opps.length === 0) {
    throw new Error(`No opportunity found for solicitation number: ${solicitationNumber}`);
  }

  const opp = opps[0];
  return {
    ...formatOpportunity(opp),
    description: opp.description ?? null,
    point_of_contact: (opp.pointOfContact ?? []).map((poc) => ({
      name: poc.fullName ?? null,
      title: poc.title ?? null,
      email: poc.email ?? null,
      phone: poc.phone ?? null,
      type: poc.type ?? null,
    })),
    resource_links: opp.resourceLinks ?? [],
    archive_type: opp.archiveType ?? null,
    archive_date: opp.archiveDate ?? null,
    organization_type: opp.organizationType ?? null,
  };
}

async function entitySearch(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    api_key: key,
    legalBusinessName: args.business_name as string,
    samRegistered: 'Yes',
    purposeOfRegistrationCode: 'Z2~Z5',
  });
  if (args.naics) params.set('naicsCode', args.naics as string);
  if (args.state) params.set('physicalAddressStateCode', args.state as string);
  if (args.small_business === true) params.set('businessTypeCode', 'SB');

  const data = (await samFetch(`${ENTITY_BASE}?${params}`)) as SamEntityResponse;
  const entities = data.entityData ?? [];

  return {
    total_records: data.totalRecords ?? 0,
    entities: entities.map((e) => {
      const reg = e.entityRegistration ?? {};
      const addr = reg.physicalAddress ?? {};
      const sbaTypes = e.assertions?.sbaBusinessTypes ?? [];

      return {
        uei: reg.ueiSAM ?? null,
        cage_code: reg.cageCode ?? null,
        legal_business_name: reg.legalBusinessName ?? null,
        dba_name: reg.dbaName ?? null,
        registration_status: reg.registrationStatus ?? null,
        registration_date: reg.registrationDate ?? null,
        expiration_date: reg.expirationDate ?? null,
        address: {
          line1: addr.addressLine1 ?? null,
          city: addr.city ?? null,
          state: addr.stateOrProvinceCode ?? null,
          zip: addr.zipCode ?? null,
          country: addr.countryCode ?? null,
        },
        primary_naics: reg.primaryNaics ?? null,
        business_types: reg.businessTypes ?? [],
        sba_certifications: sbaTypes.map((t) => t.sbaBusinessTypeDesc ?? null).filter(Boolean),
        entity_url: e.coreData?.entityInformation?.entityURL ?? null,
      };
    }),
  };
}

async function setAsideOpportunities(key: string, args: Record<string, unknown>) {
  const params = new URLSearchParams({
    api_key: key,
    typeOfSetAside: args.set_aside as string,
  });
  if (args.keyword) params.set('keyword', args.keyword as string);
  if (args.naics) params.set('ncode', args.naics as string);

  const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 10));
  params.set('limit', String(limit));

  const data = (await samFetch(`${OPPS_BASE}?${params}`)) as SamOppsResponse;
  const opps = data.opportunitiesData ?? [];

  return {
    set_aside_type: args.set_aside,
    total_records: data.totalRecords ?? 0,
    limit,
    opportunities: opps.map(formatOpportunity),
  };
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
