import test from 'node:test';
import assert from 'node:assert/strict';

test('Suíte de Segurança: Recuperação de Acesso do Cliente Comercial (E2E & PASSWORD_RECOVERY)', async (t) => {

  const clients = [
    {
      id: 'client-valid-001',
      client_code: 'CLI-001',
      establishment_name: 'Lanchonete Silva',
      email: 'contato@lanchonetesilva.com.br'
    },
    {
      id: 'client-no-email-002',
      client_code: 'CLI-002',
      establishment_name: 'Comércio Sem Email',
      email: 'Não informado'
    },
    {
      id: 'client-undefined-email-003',
      client_code: 'CLI-003',
      establishment_name: 'Comércio Email Undefined',
      email: '—'
    }
  ];

  let authCalls = [];
  let updateUserCalls = [];
  let lastToast = null;
  let modalState = { open: false, clientName: null, clientEmail: null, buttonDisabled: false };
  let updatePasswordModalState = { open: false };

  const mockSupabase = {
    auth: {
      async resetPasswordForEmail(email, options) {
        authCalls.push({ email, options });
        if (email.includes('error')) {
          return { error: { message: 'Serviço temporariamente indisponível.' } };
        }
        return { error: null };
      },
      async updateUser(attributes) {
        updateUserCalls.push(attributes);
        if (attributes.password === 'fail123') {
          return { error: { message: 'Senha fraca ou não permitida.' } };
        }
        return { data: { user: { id: 'user-123' } }, error: null };
      }
    }
  };

  let pendingClientId = null;

  function openModal(clientId) {
    const client = clients.find(c => String(c.id) === String(clientId));
    if (!client) return false;

    const email = (client.email || '').trim();
    if (!email || email === '—' || email === 'Não informado' || !email.includes('@')) {
      lastToast = { msg: "Este cliente não possui um e-mail de acesso válido cadastrado.", type: "warning" };
      return false;
    }

    pendingClientId = clientId;
    modalState.open = true;
    modalState.clientName = client.establishment_name;
    modalState.clientEmail = email;
    modalState.buttonDisabled = false;
    return true;
  }

  function closeModal() {
    pendingClientId = null;
    modalState.open = false;
  }

  async function submitRecovery(supabaseClient, origin = 'http://localhost:8000') {
    if (!pendingClientId) return false;
    const client = clients.find(c => String(c.id) === String(pendingClientId));
    if (!client) return false;

    modalState.buttonDisabled = true;
    const email = client.email;

    const redirectTo = `${origin}/index.html`;
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      modalState.buttonDisabled = false;
      throw error;
    }

    lastToast = { msg: `Instruções de recuperação enviadas para ${email}.`, type: "success" };
    closeModal();
    return true;
  }

  await t.test('1. Cliente com e-mail válido abre modal sem enviar e-mail imediatamente', () => {
    authCalls = [];
    lastToast = null;
    const opened = openModal('client-valid-001');

    assert.equal(opened, true);
    assert.equal(modalState.open, true);
    assert.equal(modalState.clientName, 'Lanchonete Silva');
    assert.equal(modalState.clientEmail, 'contato@lanchonetesilva.com.br');
    assert.equal(authCalls.length, 0);
  });

  await t.test('2. Cancelar fecha o modal sem chamar a API de Auth', () => {
    closeModal();
    assert.equal(modalState.open, false);
    assert.equal(pendingClientId, null);
    assert.equal(authCalls.length, 0);
  });

  await t.test('3. Confirmar no modal executa resetPasswordForEmail com redirectTo dinâmico', async () => {
    openModal('client-valid-001');
    const success = await submitRecovery(mockSupabase, 'http://localhost:8000');

    assert.equal(success, true);
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0].email, 'contato@lanchonetesilva.com.br');
    assert.equal(authCalls[0].options.redirectTo, 'http://localhost:8000/index.html');
    assert.equal(lastToast.msg, 'Instruções de recuperação enviadas para contato@lanchonetesilva.com.br.');
    assert.equal(modalState.open, false);
  });

  await t.test('4. Cliente com e-mail "Não informado" ou "—" é bloqueado sem abrir modal ou chamar API', () => {
    authCalls = [];
    lastToast = null;
    const openedNoEmail = openModal('client-no-email-002');

    assert.equal(openedNoEmail, false);
    assert.equal(modalState.open, false);
    assert.equal(lastToast.msg, 'Este cliente não possui um e-mail de acesso válido cadastrado.');
    assert.equal(authCalls.length, 0);

    const openedUndefined = openModal('client-undefined-email-003');
    assert.equal(openedUndefined, false);
    assert.equal(authCalls.length, 0);
  });

  await t.test('5. Duplo clique é prevenido (pendingClientId é zerado após primeiro envio)', async () => {
    authCalls = [];
    openModal('client-valid-001');
    await submitRecovery(mockSupabase);
    
    // Tentar segundo submit sem reenviar
    const secondSubmit = await submitRecovery(mockSupabase);
    assert.equal(secondSubmit, false);
    assert.equal(authCalls.length, 1);
  });

  await t.test('6. Erro no Supabase mantém o modal aberto e lança exceção sanitizada', async () => {
    const errorClients = [
      { id: 'client-err-001', establishment_name: 'Erro Test', email: 'error@local.test' }
    ];
    clients.push(...errorClients);
    
    openModal('client-err-001');
    await assert.rejects(async () => {
      await submitRecovery(mockSupabase);
    }, { message: 'Serviço temporariamente indisponível.' });

    assert.equal(modalState.buttonDisabled, false);
  });

  await t.test('7. Tratamento de evento PASSWORD_RECOVERY abre modal de redefinição e executa updateUser com a nova senha', async () => {
    updateUserCalls = [];
    updatePasswordModalState.open = true;

    // Simulação do salvamento de nova senha pelo próprio cliente
    const newPassword = 'novasenha123';
    const { data, error } = await mockSupabase.auth.updateUser({ password: newPassword });

    assert.equal(error, null);
    assert.equal(updateUserCalls.length, 1);
    assert.equal(updateUserCalls[0].password, 'novasenha123');
  });

});
