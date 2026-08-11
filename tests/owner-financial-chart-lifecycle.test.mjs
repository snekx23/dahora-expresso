import test from 'node:test';
import assert from 'node:assert/strict';

test('Suíte do Ciclo de Vida do Gráfico ownerFinancialChart (Chart.js)', async (t) => {
  // Simulador leve do ambiente DOM global
  const mockCanvas = {
    id: 'ownerFinancialChart',
    isConnected: true
  };

  let chartInstancesCreated = 0;
  let ownerFinancialChart = null;

  class MockChart {
    constructor(ctx, config) {
      chartInstancesCreated++;
      this.ctx = ctx;
      this.type = config.type;
      this.data = config.data || { datasets: [{ data: [] }] };
      this.options = config.options || {};
      this.destroyed = false;
    }
    destroy() {
      this.destroyed = true;
      this.data = undefined; // Simula comportamento real do Chart.js ao destruir
      this.ctx = undefined;
    }
    update() {
      if (this.destroyed || !this.data) {
        throw new TypeError("Cannot read properties of undefined (reading 'datasets')");
      }
      this.updated = true;
    }
  }

  const globalScope = {
    ownerFinancialChart: null,
    Chart: MockChart,
    document: {
      getElementById(id) {
        if (id === 'ownerFinancialChart') return mockCanvas;
        return null;
      }
    }
  };

  function destroyOwnerFinancialChart() {
    if (ownerFinancialChart) {
      try { ownerFinancialChart.destroy(); } catch (e) {}
      ownerFinancialChart = null;
    }
    if (globalScope.ownerFinancialChart) {
      try {
        if (globalScope.ownerFinancialChart !== ownerFinancialChart) {
          globalScope.ownerFinancialChart.destroy();
        }
      } catch (e) {}
      globalScope.ownerFinancialChart = null;
    }
  }

  function initOwnerFinancialChart() {
    const ctx = globalScope.document.getElementById('ownerFinancialChart');
    if (!ctx) return;

    destroyOwnerFinancialChart();

    ownerFinancialChart = new globalScope.Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Repasse Motoboys', 'Comissão Plataforma', 'Seguros / Taxas'],
        datasets: [{ data: [71, 24, 5] }]
      }
    });

    globalScope.ownerFinancialChart = ownerFinancialChart;
  }

  function renderOwnerFinancials(data) {
    const ownerCanvas = globalScope.document.getElementById('ownerFinancialChart');
    if (ownerCanvas && ownerCanvas.isConnected) {
      const activeChart = ownerFinancialChart || globalScope.ownerFinancialChart;
      const isChartValid = activeChart && activeChart.data && Array.isArray(activeChart.data.datasets) && activeChart.data.datasets[0];

      if (!isChartValid) {
        initOwnerFinancialChart();
      }

      const validChart = ownerFinancialChart || globalScope.ownerFinancialChart;
      if (validChart && validChart.data && Array.isArray(validChart.data.datasets) && validChart.data.datasets[0]) {
        validChart.data.datasets[0].data = [
          Number(data.rider_payout_total) || 0,
          Number(data.platform_revenue) || 0
        ];
        validChart.update();
      }
    }
  }

  await t.test('CASO A: Inicialização quando ownerFinancialChart é null cria nova instância', () => {
    destroyOwnerFinancialChart();
    assert.equal(ownerFinancialChart, null);
    assert.equal(globalScope.ownerFinancialChart, null);
    initOwnerFinancialChart();
    assert.ok(ownerFinancialChart);
    assert.equal(ownerFinancialChart.destroyed, false);
  });

  await t.test('CASO B: Gráfico válido é atualizado sem lançar erro', () => {
    initOwnerFinancialChart();
    assert.doesNotThrow(() => {
      renderOwnerFinancials({ rider_payout_total: 850, platform_revenue: 150 });
    });
    assert.equal(ownerFinancialChart.updated, true);
    assert.deepEqual(ownerFinancialChart.data.datasets[0].data, [850, 150]);
  });

  await t.test('CASO C: Gráfico destruído / data undefined não lança TypeError e recria instância', () => {
    initOwnerFinancialChart();
    const oldChart = ownerFinancialChart;
    oldChart.destroy(); // data vira undefined

    assert.doesNotThrow(() => {
      renderOwnerFinancials({ rider_payout_total: 1000, platform_revenue: 200 });
    });
    assert.notEqual(ownerFinancialChart, oldChart);
    assert.ok(ownerFinancialChart.data);
    assert.equal(ownerFinancialChart.destroyed, false);
    assert.deepEqual(ownerFinancialChart.data.datasets[0].data, [1000, 200]);
  });

  await t.test('CASO D: Trocar de aba e reinstanciar limpa a instância antiga com segurança', () => {
    const initialCount = chartInstancesCreated;
    initOwnerFinancialChart();
    initOwnerFinancialChart();
    assert.ok(chartInstancesCreated > initialCount);
    assert.equal(ownerFinancialChart.destroyed, false);
    assert.equal(globalScope.ownerFinancialChart.destroyed, false);
  });

  await t.test('CASO E: Execuções repetidas de renderOwnerFinancials não lançam exceção', () => {
    assert.doesNotThrow(() => {
      for (let i = 0; i < 10; i++) {
        renderOwnerFinancials({ rider_payout_total: 500 + i, platform_revenue: 100 });
      }
    });
    assert.equal(ownerFinancialChart.destroyed, false);
    assert.ok(Array.isArray(ownerFinancialChart.data.datasets));
  });
});
