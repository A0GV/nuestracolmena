import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import { ALL_PERMISSIONS, ORG_PERMISSIONS, PROFILE_DEFINITIONS } from '../src/common/permissions';

const prisma = new PrismaClient();

const CASE_STATUSES = [
  { value: 'New', stage: 'New', order: 0, colour: '#4a90e2' },
  { value: 'InProgress', stage: 'InProgress', order: 1, colour: '#faad14' },
  { value: 'TruePositive', stage: 'Closed', order: 2, colour: '#d0021b', requiresImpact: true },
  { value: 'FalsePositive', stage: 'Closed', order: 3, colour: '#52c41a' },
  { value: 'Indeterminate', stage: 'Closed', order: 4, colour: '#4a90e2' },
  { value: 'Duplicated', stage: 'Closed', order: 5, colour: '#a7a7b6' },
  { value: 'Other', stage: 'Closed', order: 6, colour: '#4a90e2' },
];

const ALERT_STATUSES = [
  { value: 'New', stage: 'New', order: 0, colour: '#4a90e2' },
  { value: 'InProgress', stage: 'InProgress', order: 1, colour: '#faad14' },
  { value: 'Pending', stage: 'InProgress', order: 2, colour: '#13c2c2' },
  { value: 'Imported', stage: 'Imported', order: 3, colour: '#52c41a' },
  { value: 'FalsePositive', stage: 'Closed', order: 4, colour: '#52c41a' },
  { value: 'Duplicate', stage: 'Closed', order: 5, colour: '#a7a7b6' },
  { value: 'Ignored', stage: 'Closed', order: 6, colour: '#a7a7b6' },
];

const PATTERNS = [
  { patternId: 'T1566', name: 'Phishing', tactics: ['initial-access'], platforms: ['Windows', 'Linux', 'macOS'] },
  { patternId: 'T1059', name: 'Command and Scripting Interpreter', tactics: ['execution'], platforms: ['Windows', 'Linux', 'macOS'] },
  { patternId: 'T1071', name: 'Application Layer Protocol', tactics: ['command-and-control'], platforms: ['Windows', 'Linux', 'macOS'] },
  { patternId: 'T1486', name: 'Data Encrypted for Impact', tactics: ['impact'], platforms: ['Windows', 'Linux'] },
  { patternId: 'T1041', name: 'Exfiltration Over C2 Channel', tactics: ['exfiltration'], platforms: ['Windows', 'Linux', 'macOS'] },
  { patternId: 'T1021', name: 'Remote Services', tactics: ['lateral-movement'], platforms: ['Windows', 'Linux', 'macOS'] },
  { patternId: 'T1055', name: 'Process Injection', tactics: ['defense-evasion', 'privilege-escalation'], platforms: ['Windows', 'Linux'] },
  { patternId: 'T1204', name: 'User Execution', tactics: ['execution'], platforms: ['Windows', 'Linux', 'macOS'] },
  { patternId: 'T1105', name: 'Ingress Tool Transfer', tactics: ['command-and-control'], platforms: ['Windows', 'Linux', 'macOS'] },
  { patternId: 'T1087', name: 'Account Discovery', tactics: ['discovery'], platforms: ['Windows', 'Linux', 'macOS'] },
];

async function main() {
  console.log('Seeding Nuestracolmena...');

  for (const [name, def] of Object.entries(PROFILE_DEFINITIONS)) {
    await prisma.profile.upsert({
      where: { name },
      update: { type: def.type, permissions: def.permissions as any, isSystem: true },
      create: { name, type: def.type, permissions: def.permissions as any, isSystem: true },
    });
  }

  for (const p of PATTERNS) {
    await prisma.pattern.upsert({
      where: { patternId: p.patternId },
      update: { name: p.name, tactics: p.tactics, platforms: p.platforms },
      create: { ...p, catalog: 'MITRE ATT&CK' },
    });
  }

  const soc = await prisma.organisation.upsert({
    where: { name: 'SOC' },
    update: {},
    create: { name: 'SOC', description: 'Security Operations Center' },
  });
  const partner = await prisma.organisation.upsert({
    where: { name: 'Partner' },
    update: {},
    create: { name: 'Partner', description: 'Partner organisation for sharing demos' },
  });

  for (const org of [soc, partner]) {
    await prisma.caseStatus.createMany({
      data: CASE_STATUSES.map((s) => ({ ...s, organisationId: org.id })),
      skipDuplicates: true,
    });
    await prisma.alertStatus.createMany({
      data: ALERT_STATUSES.map((s) => ({ ...s, organisationId: org.id })),
      skipDuplicates: true,
    });
  }

  const profile = async (name: string) => prisma.profile.findUniqueOrThrow({ where: { name } });
  const adminProfile = await profile('admin');
  const analystProfile = await profile('analyst');
  const readonlyProfile = await profile('read-only');
  const orgAdminProfile = await profile('org-admin');

  const passwordHash = await bcrypt.hash('admin123', 10);
  const analystHash = await bcrypt.hash('analyst123', 10);
  const readonlyHash = await bcrypt.hash('readonly123', 10);

  const admin = await prisma.user.upsert({
    where: { login: 'admin@myhive.local' },
    update: { name: 'SOC Administrator' },
    create: {
      login: 'admin@myhive.local',
      name: 'SOC Administrator',
      email: 'admin@myhive.local',
      passwordHash,
      defaultOrganisationId: soc.id,
      memberships: {
        create: [
          { organisationId: soc.id, profileId: adminProfile.id, isDefault: true },
          { organisationId: partner.id, profileId: orgAdminProfile.id },
        ],
      },
    },
  });

  const analyst = await prisma.user.upsert({
    where: { login: 'analyst@myhive.local' },
    update: { name: 'SOC Analyst' },
    create: {
      login: 'analyst@myhive.local',
      name: 'SOC Analyst',
      email: 'analyst@myhive.local',
      passwordHash: analystHash,
      defaultOrganisationId: soc.id,
      memberships: { create: [{ organisationId: soc.id, profileId: analystProfile.id, isDefault: true }] },
    },
  });

  await prisma.user.upsert({
    where: { login: 'readonly@myhive.local' },
    update: { name: 'Read Only User' },
    create: {
      login: 'readonly@myhive.local',
      name: 'Read Only User',
      email: 'readonly@myhive.local',
      passwordHash: readonlyHash,
      defaultOrganisationId: soc.id,
      memberships: { create: [{ organisationId: soc.id, profileId: readonlyProfile.id, isDefault: true }] },
    },
  });

  // Tags and custom fields
  for (const name of ['phishing', 'malware', 'email', 'finance', 'ransomware', 'c2', 'exfiltration']) {
    await prisma.tag.upsert({
      where: { organisationId_name: { organisationId: soc.id, name } },
      update: {},
      create: { organisationId: soc.id, name, colour: '#54c1c2' },
    });
  }
  await prisma.customField.upsert({
    where: { organisationId_reference: { organisationId: soc.id, reference: 'business-impact' } },
    update: {},
    create: { organisationId: soc.id, name: 'Business impact', reference: 'business-impact', type: 'string', order: 0 },
  });
  await prisma.customField.upsert({
    where: { organisationId_reference: { organisationId: soc.id, reference: 'detection-source' } },
    update: {},
    create: { organisationId: soc.id, name: 'Detection source', reference: 'detection-source', type: 'select', options: ['EDR', 'SIEM', 'Email gateway', 'User report'], order: 1 },
  });

  // Case template
  const template = await prisma.caseTemplate.upsert({
    where: { organisationId_name: { organisationId: soc.id, name: 'phishing-investigation' } },
    update: {},
    create: {
      organisationId: soc.id,
      name: 'phishing-investigation',
      displayName: 'Phishing investigation',
      titlePrefix: '[Phishing]',
      description: 'Investigate a reported phishing email and contain the campaign.',
      severity: 3,
      tlp: 2,
      pap: 2,
      tags: ['phishing', 'email'],
      createdById: admin.id,
      tasks: {
        create: [
          { title: 'Analyse email headers', group: 'Email analysis', order: 0, description: 'Check SPF, DKIM, DMARC and sender reputation.' },
          { title: 'Analyse attachments and URLs', group: 'Malware analysis', order: 1, description: 'Detonate attachments and inspect URLs in a sandbox.' },
          { title: 'Contain the campaign', group: 'Containment', order: 2, description: 'Block sender, domain and URLs; purge mailboxes.' },
        ],
      },
    },
    include: { tasks: true },
  });

  // Demo case
  const existing = await prisma.case.findFirst({ where: { organisationId: soc.id, number: 1 } });
  if (!existing) {
    const created = await prisma.case.create({
      data: {
        organisationId: soc.id,
        number: 1,
        title: 'Phishing campaign targeting finance department',
        description: '## Summary\nPhishing emails were reported by the finance department with a malicious macro attachment.\n\n## Findings\n- Spoofed sender\n- Credential harvesting URL\n- Macro-enabled attachment',
        summary: 'Campaign contained. Credentials reset and domain blocked.',
        severity: 3,
        tlp: 2,
        pap: 2,
        stage: 'InProgress',
        statusId: (await prisma.caseStatus.findFirst({ where: { organisationId: soc.id, value: 'InProgress' } }))!.id,
        assigneeId: admin.id,
        createdById: admin.id,
        tags: ['phishing', 'email', 'finance'],
        customFields: { 'business-impact': 'High', 'detection-source': 'Email gateway' },
        tasks: {
          create: [
            { organisationId: soc.id, title: 'Analyse email headers', group: 'Email analysis', status: 'InProgress', order: 0, assigneeId: analyst.id, description: 'Check SPF, DKIM and DMARC.' },
            { organisationId: soc.id, title: 'Analyse attachment in sandbox', group: 'Malware analysis', status: 'Waiting', order: 1 },
            { organisationId: soc.id, title: 'Block domain and IPs', group: 'Containment', status: 'Waiting', order: 2 },
          ],
        },
        observables: {
          create: [
            { organisationId: soc.id, dataType: 'domain', data: 'evil-finance-login.example', dataHash: createHash('sha256').update('domain:evil-finance-login.example').digest('hex'), message: 'Phishing domain', tlp: 2, ioc: true, sighted: true, tags: ['phishing'], createdById: admin.id },
            { organisationId: soc.id, dataType: 'ip', data: '185.199.108.153', dataHash: createHash('sha256').update('ip:185.199.108.153').digest('hex'), message: 'Phishing server', tlp: 2, ioc: true, tags: ['c2'], createdById: admin.id },
            { organisationId: soc.id, dataType: 'url', data: 'https://evil-finance-login.example/login', dataHash: createHash('sha256').update('url:https://evil-finance-login.example/login').digest('hex'), message: 'Credential harvesting URL', tlp: 2, ioc: true, tags: ['phishing'], createdById: admin.id },
            { organisationId: soc.id, dataType: 'mail', data: 'billing@evil-finance-login.example', dataHash: createHash('sha256').update('mail:billing@evil-finance-login.example').digest('hex'), message: 'Spoofed sender', tlp: 2, ioc: true, tags: ['email'], createdById: admin.id },
            { organisationId: soc.id, dataType: 'hash', data: '44d88612fea8a8f36de82e1278abb02f', dataHash: createHash('sha256').update('hash:44d88612fea8a8f36de82e1278abb02f').digest('hex'), message: 'MD5 of the attachment', tlp: 2, ioc: true, tags: ['malware'], createdById: admin.id },
          ],
        },
        procedures: {
          create: [
            { organisationId: soc.id, patternId: 'T1566', patternName: 'Phishing', tactic: 'initial-access', occurDate: new Date(), description: 'Phishing email with malicious attachment sent to finance.', createdById: admin.id },
          ],
        },
      },
      include: { tasks: true },
    });

    await prisma.taskLog.create({
      data: {
        organisationId: soc.id,
        taskId: created.tasks[0].id,
        caseId: created.id,
        message: 'SPF failed and the Return-Path does not match the sender domain. Spoofing confirmed.',
        createdById: admin.id,
      },
    });
    await prisma.comment.create({
      data: { organisationId: soc.id, objectType: 'case', objectId: created.id, message: 'Finance team confirmed two users clicked the link. Credentials reset.', createdById: admin.id },
    });
  }

  // Demo alert
  const alertExists = await prisma.alert.findFirst({ where: { organisationId: soc.id, sourceRef: 'MSG-2026-11-02-0042' } });
  if (!alertExists) {
    await prisma.alert.create({
      data: {
        organisationId: soc.id,
        type: 'external',
        source: 'Email Gateway',
        sourceRef: 'MSG-2026-11-02-0042',
        externalLink: 'https://mail.example.com/messages/MSG-2026-11-02-0042',
        title: 'Suspicious invoice attachment from external sender',
        description: 'Email gateway detected a .docm attachment with a suspicious macro sent to finance.',
        severity: 3,
        tlp: 2,
        pap: 2,
        stage: 'New',
        statusId: (await prisma.alertStatus.findFirst({ where: { organisationId: soc.id, value: 'New' } }))!.id,
        createdById: admin.id,
        tags: ['phishing', 'email', 'malware'],
        observables: {
          create: [
            { organisationId: soc.id, dataType: 'mail', data: 'billing@evil-finance-login.example', dataHash: createHash('sha256').update('mail:billing@evil-finance-login.example').digest('hex'), message: 'Sender', tlp: 2, ioc: true, createdById: admin.id },
            { organisationId: soc.id, dataType: 'hash', data: '44d88612fea8a8f36de82e1278abb02f', dataHash: createHash('sha256').update('hash:44d88612fea8a8f36de82e1278abb02f').digest('hex'), message: 'Attachment hash', tlp: 2, ioc: true, createdById: admin.id },
          ],
        },
        procedures: {
          create: [{ organisationId: soc.id, patternId: 'T1566', patternName: 'Phishing', tactic: 'initial-access', occurDate: new Date(), description: 'Phishing attachment.', createdById: admin.id }],
        },
      },
    });
  }

  // Dashboard
  const dash = await prisma.dashboard.findFirst({ where: { organisationId: soc.id, name: 'SOC overview' } });
  if (!dash) {
    await prisma.dashboard.create({
      data: {
        organisationId: soc.id,
        name: 'SOC overview',
        description: 'Cases, alerts, observables and TTPs at a glance',
        createdById: admin.id,
        widgets: {
          create: [
            { type: 'cases-by-status', title: 'Cases by status', position: 0 },
            { type: 'cases-by-severity', title: 'Cases by severity', position: 1 },
            { type: 'alerts-by-stage', title: 'Alerts by stage', position: 2 },
            { type: 'observables-by-type', title: 'Observables by type', position: 3 },
          ],
        },
      },
    });
  }

  const page = await prisma.page.findFirst({ where: { organisationId: soc.id, title: 'Phishing response playbook' } });
  if (!page) {
    await prisma.page.create({
      data: {
        organisationId: soc.id,
        title: 'Phishing response playbook',
        category: 'Playbooks',
        content: '# Phishing response\n\n1. Analyse headers (SPF, DKIM, DMARC).\n2. Detonate attachments and inspect URLs.\n3. Block sender, domain and URLs.\n4. Purge mailboxes.\n5. Reset compromised credentials.\n6. Document findings and close the case.',
        createdById: admin.id,
      },
    });
  }

  console.log('Seed complete.');
  console.log('admin@myhive.local / admin123');
  console.log('analyst@myhive.local / analyst123');
  console.log('readonly@myhive.local / readonly123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
